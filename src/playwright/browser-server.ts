import { ShopifyE2EInfrastructureError } from "../errors.js";
import {
	CommandSignalError,
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

const settlesWithin = async (
	operation: Promise<unknown>,
	timeoutMs: number,
): Promise<boolean> => {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), timeoutMs);
		timer.unref();
	});
	const result = await Promise.race([
		operation.then(
			() => true,
			() => false,
		),
		timeout,
	]);
	if (timer) clearTimeout(timer);
	return result;
};

const forceCloseServer = async (
	server: ConsumerBrowserServer,
	timeoutMs: number,
): Promise<void> => {
	if (await settlesWithin(server.close(), timeoutMs)) return;
	if (!(await settlesWithin(server.kill(), timeoutMs))) {
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

const createManagedServer = (
	server: ConsumerBrowserServer,
	closeTimeoutMs: number,
): ManagedBrowserServer => {
	const wsEndpoint = readEndpoint(server);
	let serverClosed = false;
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
		serverClosed = true;
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
			closePromise = serverClosed
				? Promise.resolve()
				: forceCloseServer(server, closeTimeoutMs);
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

export const launchConsumerBrowserServer = async ({
	chromium,
	closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
	launchOptions,
	signal,
}: LaunchConsumerBrowserServerArgs): Promise<ManagedBrowserServer> => {
	throwIfCommandAborted(signal);
	const launchOperation = chromium.launchServer(launchOptions);
	let resolvedServer: ConsumerBrowserServer | undefined;
	let interruptedLaunchCleanup: Promise<void> | undefined;
	const cleanInterruptedLaunch = (
		server: ConsumerBrowserServer,
	): Promise<void> => {
		interruptedLaunchCleanup ??= forceCloseServer(server, closeTimeoutMs).catch(
			() => undefined,
		);
		return interruptedLaunchCleanup;
	};
	void launchOperation
		.then(async (server) => {
			resolvedServer = server;
			if (signal.aborted) {
				await cleanInterruptedLaunch(server);
			}
		})
		.catch(() => undefined);

	let server: ConsumerBrowserServer;
	try {
		server = await runWithCommandSignal(() => launchOperation, signal);
	} catch (error) {
		if (signal.aborted && resolvedServer) {
			await cleanInterruptedLaunch(resolvedServer);
		}
		throw normalizeLaunchError(error);
	}

	if (signal.aborted) {
		await cleanInterruptedLaunch(server);
		throwIfCommandAborted(signal);
	}

	try {
		return createManagedServer(server, closeTimeoutMs);
	} catch (error) {
		await forceCloseServer(server, closeTimeoutMs).catch(() => undefined);
		throw normalizeLaunchError(error);
	}
};
