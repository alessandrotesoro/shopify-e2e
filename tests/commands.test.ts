import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedShopifyE2EConfig } from "../src/config.js";

const mocks = vi.hoisted(() => ({
	prepareShopifySession: vi.fn(),
	resolveShopifyE2EConfig: vi.fn(),
	runTestCommand: vi.fn(),
}));

vi.mock("../src/config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/config.js")>();

	return {
		...actual,
		resolveShopifyE2EConfig: mocks.resolveShopifyE2EConfig,
	};
});

vi.mock("../src/shopify-session.js", () => ({
	prepareShopifySession: mocks.prepareShopifySession,
}));

vi.mock("../src/test-runner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/test-runner.js")>();

	return {
		...actual,
		runTestCommand: mocks.runTestCommand,
	};
});

const { default: Open } = await import("../src/commands/open.js");
const { default: Run } = await import("../src/commands/run.js");

const config: ResolvedShopifyE2EConfig = {
	appUrl: "https://app.test",
	authStatePath: "/tmp/auth.json",
	cdpPort: "9222",
	cdpUrl: "http://127.0.0.1:9222",
	chromeProfilePath: "/tmp/profile",
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

describe("commands", () => {
	beforeEach(() => {
		mocks.resolveShopifyE2EConfig.mockResolvedValue(config);
		mocks.prepareShopifySession.mockResolvedValue({
			authStatePath: config.authStatePath,
			authStateRestored: true,
			chromeStarted: true,
			page: {
				url: () => "https://admin.shopify.com/store/example",
			} as Page,
		});
		mocks.runTestCommand.mockResolvedValue(0);
	});

	afterEach(() => {
		mocks.prepareShopifySession.mockReset();
		mocks.resolveShopifyE2EConfig.mockReset();
		mocks.runTestCommand.mockReset();
		process.exitCode = undefined;
	});

	it("open parses config flags and prepares the Shopify session", async () => {
		await Open.run(
			["--shop", "example.myshopify.com", "--cdp-port", "9333", "--no-wait"],
			{ root: process.cwd() },
		);

		expect(mocks.resolveShopifyE2EConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				cdpPort: 9333,
				shopDomain: "example.myshopify.com",
			}),
		);
		expect(mocks.prepareShopifySession).toHaveBeenCalledWith(
			config,
			expect.objectContaining({
				waitForLogin: false,
			}),
		);
	});

	it("run forwards pass-through args and propagates the test exit code", async () => {
		mocks.runTestCommand.mockResolvedValue(7);

		await Run.run(
			[
				"--shop",
				"example.myshopify.com",
				"--test-file",
				"e2e/live.spec.ts",
				"--",
				"--project=chromium",
			],
			{ root: process.cwd() },
		);

		expect(mocks.resolveShopifyE2EConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				shopDomain: "example.myshopify.com",
				testFiles: ["e2e/live.spec.ts"],
			}),
		);
		expect(mocks.prepareShopifySession).toHaveBeenCalledWith(
			config,
			expect.objectContaining({
				waitForLogin: true,
			}),
		);
		expect(mocks.runTestCommand).toHaveBeenCalledWith(config, [
			"--project=chromium",
		]);
		expect(process.exitCode).toBe(7);
	});
});
