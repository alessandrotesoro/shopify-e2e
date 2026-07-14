import {
	ShopifyE2EInfrastructureError,
	ShopifyE2EPreflightError,
} from "../errors.js";
import {
	CommandSignalError,
	commandSignalFromReason,
} from "../process/command-signals.js";
import { normalizeConfiguredOrigin } from "../profiles/configured-origin.js";
import type { PlaywrightStorageState } from "../profiles/profile-schema.js";
import { validateStorageState } from "../profiles/profile-schema.js";

export interface CaptureEventSource {
	off(event: string, listener: () => void): unknown;
	on(event: string, listener: () => void): unknown;
}

export interface CapturePage extends CaptureEventSource {
	close(): Promise<unknown>;
	goto(url: string): Promise<unknown>;
}

export interface CaptureContext extends CaptureEventSource {
	close(): Promise<unknown>;
	newPage(): Promise<CapturePage>;
	storageState(options: { readonly indexedDB: true }): Promise<unknown>;
}

export interface CaptureBrowser extends CaptureEventSource {
	close(): Promise<unknown>;
	newContext(options: {
		readonly storageState: PlaywrightStorageState;
	}): Promise<CaptureContext>;
}

export interface CaptureProfileDependencies {
	readonly confirmSave: (options: {
		readonly signal: AbortSignal;
	}) => Promise<boolean>;
	readonly launchChromium: (options: {
		readonly headless: false;
	}) => Promise<CaptureBrowser>;
	readonly report: (message: string) => void;
}

export interface CaptureBrowserProfileArgs {
	readonly dependencies: CaptureProfileDependencies;
	readonly initialState: PlaywrightStorageState;
	readonly origin: string;
	readonly signal: AbortSignal;
}

export type CaptureBrowserProfileResult =
	| {
			readonly state: PlaywrightStorageState;
			readonly status: "captured";
	  }
	| {
			readonly reason: "browser-closed" | "declined";
			readonly status: "cancelled";
	  };

export class CaptureSignalError extends CommandSignalError {
	public constructor(signal: "SIGINT" | "SIGTERM") {
		super(signal, `Profile capture interrupted by ${signal}`);
		this.name = "CaptureSignalError";
	}
}

class BrowserClosedCaptureError extends Error {
	public constructor() {
		super("Browser closed during profile capture");
		this.name = "BrowserClosedCaptureError";
	}
}

const throwIfCaptureAborted = (signal: AbortSignal): void => {
	if (signal.aborted) {
		throw new CaptureSignalError(commandSignalFromReason(signal.reason));
	}
};

const normalizeCaptureError = (error: unknown): Error => {
	if (
		error instanceof CaptureSignalError ||
		error instanceof ShopifyE2EPreflightError ||
		error instanceof ShopifyE2EInfrastructureError
	) {
		return error;
	}
	if (error instanceof Error && error.name === "ExitPromptError") {
		return new CaptureSignalError("SIGINT");
	}
	return new ShopifyE2EInfrastructureError(
		"Browser profile capture could not complete",
		{ cause: error },
	);
};

export const captureBrowserProfile = async ({
	dependencies,
	initialState,
	origin,
	signal,
}: CaptureBrowserProfileArgs): Promise<CaptureBrowserProfileResult> => {
	const validatedInitialState = validateStorageState(initialState);
	const normalizedOrigin = normalizeConfiguredOrigin(origin);
	if (normalizedOrigin !== origin) {
		throw new ShopifyE2EPreflightError(
			"Browser profile capture requires the normalized configured store origin",
		);
	}
	throwIfCaptureAborted(signal);

	let browser: CaptureBrowser | undefined;
	let context: CaptureContext | undefined;
	let page: CapturePage | undefined;
	let externalAbortListener: (() => void) | undefined;
	const lifecycleAbort = new AbortController();
	const listeners: Array<{
		readonly event: string;
		readonly listener: () => void;
		readonly source: CaptureEventSource;
	}> = [];
	let operationError: Error | undefined;
	let result: CaptureBrowserProfileResult | undefined;
	const externalInterruption = new Promise<never>((_resolve, reject) => {
		externalAbortListener = () =>
			reject(new CaptureSignalError(commandSignalFromReason(signal.reason)));
		if (signal.aborted) externalAbortListener();
		else
			signal.addEventListener("abort", externalAbortListener, { once: true });
	});
	const browserClosed = new Promise<"closed">((resolveClosed) => {
		const onAbort = () => resolveClosed("closed");
		if (lifecycleAbort.signal.aborted) onAbort();
		else
			lifecycleAbort.signal.addEventListener("abort", onAbort, {
				once: true,
			});
	});

	const awaitCaptureOperation = async <T>(
		operation: Promise<T>,
	): Promise<T> => {
		try {
			const outcome = await Promise.race([
				operation.then((value) => ({ kind: "value" as const, value })),
				browserClosed.then(() => ({ kind: "closed" as const })),
				externalInterruption,
			]);
			if (outcome.kind === "closed") throw new BrowserClosedCaptureError();
			return outcome.value;
		} catch (error) {
			if (signal.aborted) {
				throw new CaptureSignalError(commandSignalFromReason(signal.reason));
			}
			if (lifecycleAbort.signal.aborted) {
				throw new BrowserClosedCaptureError();
			}
			throw error;
		}
	};

	const closeResourceIfItResolvesLate = <
		T extends { close(): Promise<unknown> },
	>(
		operation: Promise<T>,
	): void => {
		void operation
			.then(async (resource) => {
				if (signal.aborted || lifecycleAbort.signal.aborted) {
					await resource.close().catch(() => undefined);
				}
			})
			.catch(() => undefined);
	};

	const addClosureListener = (
		source: CaptureEventSource,
		event: string,
	): void => {
		const listener = () => lifecycleAbort.abort("browser-closed");
		source.on(event, listener);
		listeners.push({ event, listener, source });
	};

	try {
		dependencies.report(
			`Opening dedicated capture window at ${origin}. State may include every origin visited in this window.`,
		);
		const launchOperation = dependencies.launchChromium({ headless: false });
		closeResourceIfItResolvesLate(launchOperation);
		try {
			browser = await awaitCaptureOperation(launchOperation);
		} catch (error) {
			if (
				error instanceof CaptureSignalError ||
				error instanceof BrowserClosedCaptureError
			) {
				throw error;
			}
			throw new ShopifyE2EInfrastructureError(
				"Consumer Chromium could not launch",
				{ cause: error },
			);
		}
		throwIfCaptureAborted(signal);
		addClosureListener(browser, "disconnected");
		const contextOperation = browser.newContext({
			storageState: validatedInitialState,
		});
		closeResourceIfItResolvesLate(contextOperation);
		context = await awaitCaptureOperation(contextOperation);
		throwIfCaptureAborted(signal);
		addClosureListener(context, "close");
		const pageOperation = context.newPage();
		closeResourceIfItResolvesLate(pageOperation);
		page = await awaitCaptureOperation(pageOperation);
		throwIfCaptureAborted(signal);
		addClosureListener(page, "close");
		await awaitCaptureOperation(page.goto(origin));
		throwIfCaptureAborted(signal);

		const combinedSignal = AbortSignal.any([signal, lifecycleAbort.signal]);
		const confirmation: Promise<"closed" | "confirmed" | "declined"> =
			dependencies
				.confirmSave({ signal: combinedSignal })
				.then((confirmed) => (confirmed ? "confirmed" : "declined"))
				.catch((error: unknown) => {
					if (signal.aborted) {
						throw new CaptureSignalError(
							commandSignalFromReason(signal.reason),
						);
					}
					if (lifecycleAbort.signal.aborted) return "closed";
					throw error;
				});
		const outcome = await Promise.race([
			confirmation,
			browserClosed,
			externalInterruption,
		]);
		if (outcome === "closed") {
			result = { reason: "browser-closed", status: "cancelled" };
		} else if (outcome === "declined") {
			result = { reason: "declined", status: "cancelled" };
		} else {
			const captured = await Promise.race([
				context
					.storageState({ indexedDB: true })
					.then((state) => ({ state, status: "captured" as const })),
				browserClosed,
				externalInterruption,
			]);
			if (captured === "closed") {
				result = { reason: "browser-closed", status: "cancelled" };
			} else {
				throwIfCaptureAborted(signal);
				if (lifecycleAbort.signal.aborted) {
					result = { reason: "browser-closed", status: "cancelled" };
				} else {
					const state = validateStorageState(captured.state);
					throwIfCaptureAborted(signal);
					if (lifecycleAbort.signal.aborted) {
						result = { reason: "browser-closed", status: "cancelled" };
					} else {
						result = { state, status: "captured" };
					}
				}
			}
		}
	} catch (error) {
		if (error instanceof BrowserClosedCaptureError) {
			result = { reason: "browser-closed", status: "cancelled" };
		} else {
			operationError = normalizeCaptureError(error);
		}
	} finally {
		let cleanupCause: unknown;
		if (externalAbortListener) {
			signal.removeEventListener("abort", externalAbortListener);
		}
		if (!lifecycleAbort.signal.aborted) {
			lifecycleAbort.abort("cleanup");
		}
		for (const { event, listener, source } of listeners) {
			try {
				source.off(event, listener);
			} catch (error) {
				cleanupCause ??= error;
			}
		}
		for (const resource of [page, context, browser]) {
			try {
				await resource?.close();
			} catch (error) {
				cleanupCause ??= error;
			}
		}
		if (!operationError && cleanupCause !== undefined) {
			operationError = new ShopifyE2EInfrastructureError(
				"Browser profile capture cleanup could not complete",
				{ cause: cleanupCause },
			);
		}
	}
	if (operationError) throw operationError;
	if (!result) {
		throw new ShopifyE2EInfrastructureError(
			"Browser profile capture could not complete",
		);
	}
	return result;
};
