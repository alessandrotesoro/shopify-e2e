import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/browser.js";
import type { ResolvedShopifyE2EConfig } from "../src/shopify-e2e-config.js";

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	spawn: vi.fn(),
	unref: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: mocks.spawn,
}));

vi.mock("node:fs", () => ({
	existsSync: mocks.existsSync,
	mkdirSync: mocks.mkdirSync,
}));

const { ensureChrome } = await import("../src/browser.js");

interface ChildProcessDouble extends EventEmitter {
	unref: ReturnType<typeof vi.fn>;
}

const config: ResolvedShopifyE2EConfig = {
	appUrl: "https://app.test",
	authStatePath: "/tmp/auth.json",
	cdpPort: "9333",
	cdpUrl: "http://127.0.0.1:9333",
	chromeExecutablePath: "/Applications/Test Chrome",
	chromeProfilePath: "/tmp/shopify-e2e-profile",
	cwd: "/tmp",
	live: true,
	shopDomain: "example.myshopify.com",
	testCommand: {
		args: ["playwright", "test"],
		command: "npx",
		mode: "playwright",
		shell: false,
	},
	testFiles: [],
};

describe("ensureChrome", () => {
	beforeEach(() => {
		mocks.existsSync.mockReset();
		mocks.mkdirSync.mockReset();
		mocks.spawn.mockReset();
		mocks.unref.mockReset();
		mocks.existsSync.mockReturnValue(true);
		mocks.spawn.mockReturnValue(childProcessDouble());
	});

	it("reuses an existing CDP endpoint without spawning Chrome", async () => {
		const fetchImpl: FetchLike = vi.fn(async () => ({
			json: async () => ({}),
			ok: true,
			status: 200,
		}));

		await expect(
			ensureChrome(config, "https://admin.shopify.com/store/example", {
				fetch: fetchImpl,
			}),
		).resolves.toMatchObject({
			cdpUrl: config.cdpUrl,
			profilePath: config.chromeProfilePath,
			started: false,
		});

		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(mocks.mkdirSync).not.toHaveBeenCalled();
	});

	it("starts Chrome with CDP and a persistent profile when CDP is offline", async () => {
		let attempt = 0;
		const fetchImpl: FetchLike = vi.fn(async () => {
			attempt += 1;

			return {
				json: async () => ({}),
				ok: attempt > 1,
				status: attempt > 1 ? 200 : 503,
			};
		});

		await expect(
			ensureChrome(config, "https://admin.shopify.com/store/example", {
				fetch: fetchImpl,
				timeoutMs: 100,
			}),
		).resolves.toMatchObject({
			chromePath: config.chromeExecutablePath,
			cdpUrl: config.cdpUrl,
			profilePath: config.chromeProfilePath,
			started: true,
		});

		expect(mocks.mkdirSync).toHaveBeenCalledWith(config.chromeProfilePath, {
			recursive: true,
		});
		expect(mocks.spawn).toHaveBeenCalledWith(
			config.chromeExecutablePath,
			expect.arrayContaining([
				"--remote-debugging-port=9333",
				`--user-data-dir=${config.chromeProfilePath}`,
				"https://admin.shopify.com/store/example",
			]),
			expect.objectContaining({
				detached: true,
				stdio: "ignore",
			}),
		);
		expect(mocks.unref).toHaveBeenCalled();
	});

	it("reports Chrome spawn errors with the executable path", async () => {
		const child = childProcessDouble();
		const fetchImpl: FetchLike = vi.fn(async () => ({
			json: async () => ({}),
			ok: false,
			status: 503,
		}));

		mocks.spawn.mockImplementation(() => {
			setTimeout(() => {
				child.emit("error", new Error("EACCES"));
			}, 0);

			return child;
		});

		await expect(
			ensureChrome(config, "https://admin.shopify.com/store/example", {
				fetch: fetchImpl,
				timeoutMs: 100,
			}),
		).rejects.toThrow(
			"Could not start Chrome at /Applications/Test Chrome: EACCES",
		);
		expect(mocks.unref).toHaveBeenCalled();
	});
});

function childProcessDouble(): ChildProcessDouble {
	const child = new EventEmitter() as ChildProcessDouble;

	child.unref = mocks.unref;

	return child;
}
