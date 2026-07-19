import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { ShopifyE2EInfrastructureError } from "../src/errors.js";
import {
	launchConsumerBrowserServer,
	type ManagedBrowserServer,
} from "../src/playwright/browser-server.js";
import type {
	BrowserServerLaunchOptions,
	ConsumerBrowserServer,
	ConsumerChromiumLauncher,
} from "../src/playwright/peer.js";
import { CommandSignalError } from "../src/process/command-signals.js";

class FakeBrowserServer extends EventEmitter implements ConsumerBrowserServer {
	public readonly close = vi.fn(async () => undefined);
	public readonly kill = vi.fn(async () => undefined);

	public constructor(private readonly endpoint = "ws://127.0.0.1:1234/secret") {
		super();
	}

	public wsEndpoint(): string {
		return this.endpoint;
	}
}

const launchOptions: BrowserServerLaunchOptions = Object.freeze({
	handleSIGHUP: true,
	handleSIGINT: false,
	handleSIGTERM: false,
	headless: false,
	host: "127.0.0.1",
	port: 0,
});

const launcher = (
	launchServer: NonNullable<ConsumerChromiumLauncher["launchServer"]>,
): ConsumerChromiumLauncher => ({
	executablePath: () => "/consumer/chromium",
	launch: async () => {
		throw new Error("not used");
	},
	launchServer,
});

const launch = async (
	server: FakeBrowserServer,
	options: Partial<Parameters<typeof launchConsumerBrowserServer>[0]> = {},
): Promise<ManagedBrowserServer> =>
	launchConsumerBrowserServer({
		chromium: launcher(async () => server),
		launchOptions,
		signal: new AbortController().signal,
		...options,
	});

describe("consumer Chromium BrowserServer ownership", () => {
	it("launches once with the normalized headed loopback options", async () => {
		const server = new FakeBrowserServer();
		const launchServer = vi.fn(async () => server);

		const managed = await launchConsumerBrowserServer({
			chromium: launcher(launchServer),
			launchOptions,
			signal: new AbortController().signal,
		});

		expect(launchServer).toHaveBeenCalledOnce();
		expect(launchServer).toHaveBeenCalledWith(launchOptions);
		expect(managed.wsEndpoint).toBe("ws://127.0.0.1:1234/secret");
		await managed.close();
	});

	it("rejects a malformed endpoint without exposing it", async () => {
		const endpoint = "consumer-secret-endpoint";
		const server = new FakeBrowserServer(endpoint);

		const error = await launch(server).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ShopifyE2EInfrastructureError);
		expect((error as Error).message).toMatch(/endpoint/i);
		expect((error as Error).message).not.toContain(endpoint);
		expect((error as Error).cause).toBeUndefined();
		expect(server.close).toHaveBeenCalledOnce();
	});

	it("sanitizes launch rejection without attempting server cleanup", async () => {
		const launchSecret = "launch-secret";
		const error = await launchConsumerBrowserServer({
			chromium: launcher(async () => {
				throw new Error(launchSecret);
			}),
			launchOptions,
			signal: new AbortController().signal,
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ShopifyE2EInfrastructureError);
		expect((error as Error).message).toMatch(/could not launch/i);
		expect((error as Error).message).not.toContain(launchSecret);
	});

	it("reports an unexpected server close without exposing the endpoint", async () => {
		const server = new FakeBrowserServer();
		const managed = await launch(server);

		server.emit("close");

		const error = await managed.unexpectedClose;
		expect(error).toBeInstanceOf(ShopifyE2EInfrastructureError);
		expect(error.message).toMatch(/unexpectedly/i);
		expect(error.message).not.toContain(managed.wsEndpoint);
	});

	it("closes gracefully exactly once", async () => {
		const server = new FakeBrowserServer();
		const managed = await launch(server);

		await Promise.all([managed.close(), managed.close(), managed.close()]);

		expect(server.close).toHaveBeenCalledOnce();
		expect(server.kill).not.toHaveBeenCalled();
	});

	it("kills the server when graceful close exceeds its bound", async () => {
		const server = new FakeBrowserServer();
		server.close.mockImplementation(() => new Promise(() => undefined));
		const managed = await launch(server, { closeTimeoutMs: 5 });

		await managed.close();

		expect(server.close).toHaveBeenCalledOnce();
		expect(server.kill).toHaveBeenCalledOnce();
	});

	it("fails cleanup without leaking causes when graceful close and kill fail", async () => {
		const server = new FakeBrowserServer();
		server.close.mockRejectedValue(new Error("close secret"));
		server.kill.mockRejectedValue(new Error("kill secret"));
		const managed = await launch(server, { closeTimeoutMs: 5 });

		const error = await managed.close().catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ShopifyE2EInfrastructureError);
		expect((error as Error).message).toMatch(/cleanup/i);
		expect((error as Error).message).not.toMatch(/close secret|kill secret/i);
	});

	it("does not launch after an earlier abort", async () => {
		const controller = new AbortController();
		controller.abort("SIGTERM");
		const launchServer = vi.fn(async () => new FakeBrowserServer());

		const error = await launchConsumerBrowserServer({
			chromium: launcher(launchServer),
			launchOptions,
			signal: controller.signal,
		}).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(CommandSignalError);
		expect((error as CommandSignalError).exitCode).toBe(143);
		expect(launchServer).not.toHaveBeenCalled();
	});

	it("closes a server that resolves after launch is interrupted", async () => {
		const controller = new AbortController();
		const server = new FakeBrowserServer();
		let resolveLaunch: ((server: ConsumerBrowserServer) => void) | undefined;
		const launchServer = vi.fn(
			() =>
				new Promise<ConsumerBrowserServer>((resolve) => {
					resolveLaunch = resolve;
				}),
		);
		const operation = launchConsumerBrowserServer({
			chromium: launcher(launchServer),
			closeTimeoutMs: 50,
			launchOptions,
			signal: controller.signal,
		});

		controller.abort("SIGINT");
		resolveLaunch?.(server);
		await expect(operation).rejects.toBeInstanceOf(CommandSignalError);
		await vi.waitFor(() => expect(server.close).toHaveBeenCalledOnce());
	});

	it("keeps signal precedence while reporting interrupted cleanup failure", async () => {
		const controller = new AbortController();
		const server = new FakeBrowserServer();
		server.close.mockRejectedValue(new Error("private close failure"));
		server.kill.mockRejectedValue(new Error("private kill failure"));
		let resolveLaunch: ((server: ConsumerBrowserServer) => void) | undefined;
		const operation = launchConsumerBrowserServer({
			chromium: launcher(
				() =>
					new Promise<ConsumerBrowserServer>((resolve) => {
						resolveLaunch = resolve;
					}),
			),
			closeTimeoutMs: 10,
			launchOptions,
			signal: controller.signal,
		});

		controller.abort("SIGTERM");
		resolveLaunch?.(server);
		const error = await operation.catch((cause: unknown) => cause);

		expect(error).toMatchObject({ exitCode: 143, signal: "SIGTERM" });
		expect(String(error)).toMatch(/cleanup could not complete/i);
		expect(String(error)).not.toMatch(/private close|private kill/i);
		expect(server.close).toHaveBeenCalledOnce();
		expect(server.kill).toHaveBeenCalledOnce();
	});

	it("cleans exactly once when launch resolution races interruption", async () => {
		const controller = new AbortController();
		const server = new FakeBrowserServer();
		let resolveLaunch: ((server: ConsumerBrowserServer) => void) | undefined;
		const operation = launchConsumerBrowserServer({
			chromium: launcher(
				() =>
					new Promise<ConsumerBrowserServer>((resolve) => {
						resolveLaunch = resolve;
					}),
			),
			launchOptions,
			signal: controller.signal,
		});

		resolveLaunch?.(server);
		controller.abort("SIGTERM");
		await expect(operation).rejects.toMatchObject({ exitCode: 143 });
		await vi.waitFor(() => expect(server.close).toHaveBeenCalledOnce());
	});
});
