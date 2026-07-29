import { ShopifyE2EInfrastructureError } from "../errors.js";
import {
	CommandSignalError,
	commandSignalFromReason,
	runWithCommandSignal,
	throwIfCommandAborted,
} from "../process/command-signals.js";
import type {
	BrowserServerLaunchOptions,
	ConsumerBrowserServer,
	ConsumerChromiumLauncher,
} from "./peer.js";

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

export interface ManagedBrowserServer {
	readonly unexpectedClose: Promise<ShopifyE2EInfrastructureError>;
	readonly wsEndpoint: string;
	close(): Promise<void>;
}

export interface LaunchConsumerBrowserServerArgs {
	readonly chromium: ConsumerChromiumLauncher;
	readonly closeTimeoutMs?: number;
	readonly launchOptions: BrowserServerLaunchOptions;
	readonly signal: AbortSignal;
}

interface SettlesWithinArgs {
	operation: Promise<unknown>;
	timeoutMs: number;
}

const settlesWithin = async ({
	operation,
	timeoutMs,
}: SettlesWithinArgs): Promise<boolean> => {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), timeoutMs);
		timer.unref();
	});
	const didSettle = await Promise.race([
		operation.then(
			() => true,
			() => false,
		),
		timeout,
	]);
	if (timer) clearTimeout(timer);
	return didSettle;
};

interface ResolvesWithinArgs<Value> {
	operation: Promise<Value>;
	timeoutMs: number;
}

const resolvesWithin = async <Value>({
	operation,
	timeoutMs,
}: ResolvesWithinArgs<Value>): Promise<Value | undefined> => {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), timeoutMs);
		timer.unref();
	});
	const result = await Promise.race([
		operation.catch(() => undefined),
		timeout,
	]);
	if (timer) clearTimeout(timer);
	return result;
};

interface ForceCloseServerArgs {
	server: ConsumerBrowserServer;
	timeoutMs: number;
}

const forceCloseServer = async ({
	server,
	timeoutMs,
}: ForceCloseServerArgs): Promise<void> => {
	if (await settlesWithin({ operation: server.close(), timeoutMs })) return;
	if (!(await settlesWithin({ operation: server.kill(), timeoutMs }))) {
		throw new ShopifyE2EInfrastructureError(
			"Consumer Chromium server cleanup could not complete",
		);
	}
};

const readEndpoint = (server: ConsumerBrowserServer): string => {
	let endpoint: string;
	try {
		endpoint = server.wsEndpoint();
		const parsed = new URL(endpoint);
		if (
			(parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
			(parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") ||
			parsed.pathname.length <= 1
		) {
			throw new Error("invalid endpoint");
		}
	} catch {
		throw new ShopifyE2EInfrastructureError(
			"Consumer Chromium server returned an invalid native endpoint",
		);
	}
	return endpoint;
};

interface CreateManagedServerArgs {
	server: ConsumerBrowserServer;
	closeTimeoutMs: number;
}

const createManagedServer = ({
	server,
	closeTimeoutMs,
}: CreateManagedServerArgs): ManagedBrowserServer => {
	const wsEndpoint = readEndpoint(server);
	let isServerClosed = false;
	let closePromise: Promise<void> | undefined;
	let resolveUnexpectedClose:
		| ((error: ShopifyE2EInfrastructureError) => void)
		| undefined;
	const unexpectedClose = new Promise<ShopifyE2EInfrastructureError>(
		(resolve) => {
			resolveUnexpectedClose = resolve;
		},
	);
	const onClose = (): void => {
		isServerClosed = true;
		resolveUnexpectedClose?.(
			new ShopifyE2EInfrastructureError(
				"Consumer Chromium server closed unexpectedly",
			),
		);
	};
	server.on("close", onClose);

	return {
		close: () => {
			if (closePromise) return closePromise;
			server.off("close", onClose);
			closePromise = isServerClosed
				? Promise.resolve()
				: forceCloseServer({ server, timeoutMs: closeTimeoutMs });
			return closePromise;
		},
		unexpectedClose,
		wsEndpoint,
	};
};

const normalizeLaunchError = (error: unknown): Error => {
	if (
		error instanceof CommandSignalError ||
		error instanceof ShopifyE2EInfrastructureError
	) {
		return error;
	}
	return new ShopifyE2EInfrastructureError(
		"Consumer Chromium server could not launch",
		{ cause: error },
	);
};

const interruptedCleanupError = (signal: AbortSignal): CommandSignalError => {
	const interruption = new CommandSignalError(
		commandSignalFromReason(signal.reason),
	);
	return new CommandSignalError(
		interruption.signal,
		`${interruption.message}; consumer Chromium cleanup could not complete`,
	);
};

export const launchConsumerBrowserServer = async ({
	chromium,
	closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
	launchOptions,
	signal,
}: LaunchConsumerBrowserServerArgs): Promise<ManagedBrowserServer> => {
	throwIfCommandAborted(signal);
	const launchOperation = chromium.launchServer(launchOptions);
	let interruptedLaunchCleanup: Promise<void> | undefined;
	const cleanInterruptedLaunch = (
		server: ConsumerBrowserServer,
	): Promise<void> => {
		interruptedLaunchCleanup ??= forceCloseServer({
			server,
			timeoutMs: closeTimeoutMs,
		});
		return interruptedLaunchCleanup;
	};
	void launchOperation
		.then(async (server) => {
			if (signal.aborted) {
				await cleanInterruptedLaunch(server);
			}
		})
		.catch(() => undefined);

	let server: ConsumerBrowserServer;
	try {
		server = await runWithCommandSignal({
			operation: () => launchOperation,
			signal,
		});
	} catch (error) {
		if (signal.aborted) {
			const serverToClean = await resolvesWithin({
				operation: launchOperation,
				timeoutMs: closeTimeoutMs,
			});
			if (serverToClean) {
				try {
					await cleanInterruptedLaunch(serverToClean);
				} catch {
					throw interruptedCleanupError(signal);
				}
			}
		}
		throw normalizeLaunchError(error);
	}

	if (signal.aborted) {
		try {
			await cleanInterruptedLaunch(server);
		} catch {
			throw interruptedCleanupError(signal);
		}
		throwIfCommandAborted(signal);
	}

	try {
		return createManagedServer({ server, closeTimeoutMs });
	} catch (error) {
		await forceCloseServer({ server, timeoutMs: closeTimeoutMs });
		throw normalizeLaunchError(error);
	}
};
