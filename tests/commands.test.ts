import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedShopifyE2EConfig } from "../src/config.js";

const mocks = vi.hoisted(() => ({
	prepareShopifySession: vi.fn(),
	resolveShopifyE2EConfig: vi.fn(),
	ensureChrome: vi.fn(),
	authStateExists: vi.fn(),
	restoreAuthState: vi.fn(),
	runTestCommand: vi.fn(),
	saveAuthState: vi.fn(),
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

vi.mock("../src/auth-state.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/auth-state.js")>();

	return {
		...actual,
		authStateExists: mocks.authStateExists,
		restoreAuthState: mocks.restoreAuthState,
		saveAuthState: mocks.saveAuthState,
	};
});

vi.mock("../src/browser.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/browser.js")>();

	return {
		...actual,
		ensureChrome: mocks.ensureChrome,
	};
});

vi.mock("../src/test-runner.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/test-runner.js")>();

	return {
		...actual,
		runTestCommand: mocks.runTestCommand,
	};
});

const { default: Open } = await import("../src/commands/open.js");
const { default: Run } = await import("../src/commands/run.js");
const { default: AuthSave } = await import("../src/commands/auth/save.js");
const { default: AuthRestore } = await import("../src/commands/auth/restore.js");

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
		vi.resetAllMocks();
		mocks.resolveShopifyE2EConfig.mockResolvedValue(config);
		mocks.prepareShopifySession.mockResolvedValue({
			authStatePath: config.authStatePath,
			authStateRestored: true,
			authStateSaved: true,
			chromeStarted: true,
			page: {
				url: () => "https://admin.shopify.com/store/example",
			} as Page,
		});
		mocks.runTestCommand.mockResolvedValue(0);
		mocks.saveAuthState.mockResolvedValue({ path: config.authStatePath });
		mocks.authStateExists.mockReturnValue(true);
		mocks.restoreAuthState.mockResolvedValue({
			path: config.authStatePath,
			restored: true,
		});
		mocks.ensureChrome.mockResolvedValue({
			cdpUrl: config.cdpUrl,
			profilePath: config.chromeProfilePath,
			started: false,
		});
	});

	afterEach(() => {
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

	it("run fails before preparing the session when app URL is missing", async () => {
		mocks.resolveShopifyE2EConfig.mockResolvedValue({
			...config,
			appUrl: undefined,
		});

		await expect(Run.run(["--shop", "example.myshopify.com"], { root: process.cwd() })).rejects.toThrow(
			/Missing live Shopify e2e prerequisites: SHOPIFY_E2E_APP_URL/,
		);
		expect(mocks.prepareShopifySession).not.toHaveBeenCalled();
		expect(mocks.runTestCommand).not.toHaveBeenCalled();
	});

	it("auth save only saves the current CDP context", async () => {
		await AuthSave.run(["--auth-state", "/tmp/saved-auth.json"], {
			root: process.cwd(),
		});

		expect(mocks.saveAuthState).toHaveBeenCalledWith(config);
		expect(mocks.prepareShopifySession).not.toHaveBeenCalled();
	});

	it("auth restore skips Chrome startup when no auth state exists", async () => {
		mocks.authStateExists.mockReturnValue(false);

		await AuthRestore.run(["--shop", "example.myshopify.com"], {
			root: process.cwd(),
		});

		expect(mocks.ensureChrome).not.toHaveBeenCalled();
		expect(mocks.restoreAuthState).not.toHaveBeenCalled();
	});

	it("auth restore starts Chrome only when an auth state can be restored", async () => {
		await AuthRestore.run(["--shop", "example.myshopify.com"], {
			root: process.cwd(),
		});

		expect(mocks.ensureChrome).toHaveBeenCalledWith(
			config,
			"https://admin.shopify.com/store/example",
		);
		expect(mocks.restoreAuthState).toHaveBeenCalledWith(config);
	});
});
