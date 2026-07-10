import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedShopifyE2EConfig } from "../src/shopify-e2e-config.js";

const mocks = vi.hoisted(() => ({
	captureShopifyAuthProfile: vi.fn(),
	prepareShopifySession: vi.fn(),
	resolveShopifyE2EConfig: vi.fn(),
	runAppSetupCommand: vi.fn(),
	runTestCommand: vi.fn(),
	validateShopifySession: vi.fn(),
	waitForInteractiveConfirmation: vi.fn(),
}));

vi.mock("../src/shopify-e2e-config.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/shopify-e2e-config.js")>()),
	resolveShopifyE2EConfig: mocks.resolveShopifyE2EConfig,
}));

vi.mock("../src/app-setup-runner.js", () => ({
	runAppSetupCommand: mocks.runAppSetupCommand,
}));

vi.mock("../src/shopify-session.js", () => ({
	captureShopifyAuthProfile: mocks.captureShopifyAuthProfile,
	prepareShopifySession: mocks.prepareShopifySession,
	validateShopifySession: mocks.validateShopifySession,
}));

vi.mock("../src/interactive-session.js", () => ({
	waitForInteractiveConfirmation: mocks.waitForInteractiveConfirmation,
}));

vi.mock("../src/test-runner.js", () => ({
	runTestCommand: mocks.runTestCommand,
}));

const { default: Open } = await import("../src/commands/open.js");
const { default: Run } = await import("../src/commands/run.js");
const { default: AuthSave } = await import("../src/commands/auth/save.js");

const config: ResolvedShopifyE2EConfig = {
	appUrl: "https://app.test",
	authProfile: {
		name: "customer-a",
		storageStatePath: "/tmp/.shopify-e2e/auth/profiles/customer-a.json",
	},
	cdpPort: "9222",
	cdpUrl: "http://127.0.0.1:9222",
	chromeProfilePath: "/tmp/chrome",
	cwd: "/tmp",
	live: true,
	shopDomain: "example.myshopify.com",
	testCommand: {
		args: ["playwright", "test"],
		command: "npx",
	},
	testFiles: [],
};

describe("commands", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.resolveShopifyE2EConfig.mockImplementation(
			async (overrides = {}) => {
				const selected =
					typeof overrides.authProfile === "string"
						? overrides.authProfile
						: config.authProfile.name;

				return {
					...config,
					testFiles: overrides.testFiles ?? config.testFiles,
					authProfile: {
						name: selected,
						storageStatePath: `/tmp/.shopify-e2e/auth/profiles/${selected}.json`,
					},
				};
			},
		);
		mocks.captureShopifyAuthProfile.mockResolvedValue({
			chromeStarted: false,
			profile: config.authProfile,
			saved: true,
		});
		mocks.prepareShopifySession.mockResolvedValue({
			chromeStarted: false,
			close: vi.fn(async () => undefined),
			page: {
				url: () => "https://admin.shopify.com/store/example",
			} as Page,
		});
		mocks.runAppSetupCommand.mockResolvedValue(0);
		mocks.runTestCommand.mockResolvedValue(0);
		mocks.validateShopifySession.mockResolvedValue(undefined);
		mocks.waitForInteractiveConfirmation.mockResolvedValue("confirmed");
	});

	afterEach(() => {
		process.exitCode = undefined;
	});

	it("opens one isolated selected-profile inspection and closes it after completion", async () => {
		await Open.run(["--auth-profile", "customer-a"], {
			root: process.cwd(),
		});

		expect(mocks.prepareShopifySession).toHaveBeenCalledWith(config, {
			waitForLogin: false,
		});
		expect(mocks.waitForInteractiveConfirmation).toHaveBeenCalledWith({
			page: expect.anything(),
		});
		const session =
			await mocks.prepareShopifySession.mock.results[0]?.value;
		expect(session.close).toHaveBeenCalledOnce();
	});

	it("removes the obsolete open wait flag", async () => {
		await expect(
			Open.run(["--no-wait"], { root: process.cwd() }),
		).rejects.toThrow(/Nonexistent flag: --no-wait/);
	});

	it("validates run without creating a parent context, then runs setup and tests", async () => {
		mocks.runTestCommand.mockResolvedValue(7);

		await Run.run(
			[
				"--auth-profile",
				"customer-a",
				"--test-file",
				"e2e/live.spec.ts",
				"--",
				"--project=chromium",
			],
			{ root: process.cwd() },
		);

		expect(mocks.prepareShopifySession).not.toHaveBeenCalled();
		expect(mocks.validateShopifySession).toHaveBeenCalledWith(
			expect.objectContaining({
				authProfile: expect.objectContaining({ name: "customer-a" }),
			}),
		);
		expect(mocks.runAppSetupCommand).toHaveBeenCalledOnce();
		expect(mocks.runTestCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				authProfile: expect.objectContaining({ name: "customer-a" }),
				testFiles: ["e2e/live.spec.ts"],
			}),
			["--project=chromium"],
		);
		expect(
			mocks.validateShopifySession.mock.invocationCallOrder[0],
		).toBeLessThan(
			mocks.runAppSetupCommand.mock.invocationCallOrder[0] ?? 0,
		);
		expect(
			mocks.runAppSetupCommand.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.runTestCommand.mock.invocationCallOrder[0] ?? 0);
		expect(process.exitCode).toBe(7);
	});

	it.each([
		"--wait",
		"--test-command",
	])("removes the obsolete run flag %s", async (flag) => {
		await expect(
			Run.run([flag, "unused"], { root: process.cwd() }),
		).rejects.toThrow(/Nonexistent flag/);
	});

	it("stops before setup and tests when the selected profile is invalid", async () => {
		mocks.validateShopifySession.mockRejectedValue(
			new Error("selected profile is malformed"),
		);

		await expect(
			Run.run(["--auth-profile", "customer-a"], {
				root: process.cwd(),
			}),
		).rejects.toThrow("selected profile is malformed");
		expect(mocks.runAppSetupCommand).not.toHaveBeenCalled();
		expect(mocks.runTestCommand).not.toHaveBeenCalled();
	});

	it("captures a selected profile from an explicit base profile", async () => {
		await AuthSave.run(
			[
				"--auth-profile",
				"customer-a",
				"--from-auth-profile",
				"admin-base",
			],
			{ root: process.cwd() },
		);

		expect(mocks.captureShopifyAuthProfile).toHaveBeenCalledWith(
			expect.objectContaining({
				authProfile: expect.objectContaining({ name: "customer-a" }),
			}),
			expect.objectContaining({
				empty: false,
				fromAuthProfile: {
					name: "admin-base",
					storageStatePath:
						"/tmp/.shopify-e2e/auth/profiles/admin-base.json",
				},
			}),
		);
	});

	it("captures an explicitly empty profile and rejects conflicting seed flags", async () => {
		await AuthSave.run(["--auth-profile", "admin-base", "--empty"], {
			root: process.cwd(),
		});

		expect(mocks.captureShopifyAuthProfile).toHaveBeenCalledWith(
			expect.objectContaining({
				authProfile: expect.objectContaining({ name: "admin-base" }),
			}),
			expect.objectContaining({ empty: true }),
		);

		await expect(
			AuthSave.run(["--empty", "--from-auth-profile", "admin-base"], {
				root: process.cwd(),
			}),
		).rejects.toThrow(/cannot also be provided/);
	});
});
