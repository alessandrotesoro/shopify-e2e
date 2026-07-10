import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedShopifyE2EConfig } from "../src/shopify-e2e-config.js";

const mocks = vi.hoisted(() => ({
	findChromeExecutable: vi.fn(),
	isCdpReachable: vi.fn(),
	loadAuthProfile: vi.fn(),
	prepareShopifySession: vi.fn(),
}));

vi.mock("../src/browser.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/browser.js")>()),
	findChromeExecutable: mocks.findChromeExecutable,
	isCdpReachable: mocks.isCdpReachable,
}));

vi.mock("../src/auth-profile.js", () => ({
	loadAuthProfile: mocks.loadAuthProfile,
}));

vi.mock("../src/shopify-session.js", () => ({
	prepareShopifySession: mocks.prepareShopifySession,
}));

const { runDoctor } = await import("../src/doctor-checks.js");

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
	testCommand: { args: ["playwright", "test"], command: "npx" },
	testFiles: [],
};

describe("doctor checks", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.findChromeExecutable.mockReturnValue("/Applications/Chrome");
		mocks.isCdpReachable.mockResolvedValue(true);
		mocks.loadAuthProfile.mockResolvedValue({ cookies: [], origins: [] });
		mocks.prepareShopifySession.mockResolvedValue({
			close: vi.fn(async () => undefined),
			page: { url: () => "https://admin.shopify.com/store/example" },
		});
	});

	it("rejects unsafe CDP before reading the selected bearer profile", async () => {
		const checks = await runDoctor({
			...config,
			cdpUrl: "https://operator:secret@cdp.example.com/session/bearer?token=sensitive",
		});

		expect(checks).toContainEqual(
			expect.objectContaining({ name: "cdp-safety", status: "fail" }),
		);
		expect(mocks.loadAuthProfile).not.toHaveBeenCalled();
		expect(mocks.prepareShopifySession).not.toHaveBeenCalled();
		expect(JSON.stringify(checks)).not.toContain("secret");
		expect(JSON.stringify(checks)).not.toContain("bearer");
		expect(JSON.stringify(checks)).not.toContain("sensitive");
	});

	it.each([
		"missing",
		"malformed",
	])("reports a %s selected profile without fallback", async (state) => {
		mocks.loadAuthProfile.mockRejectedValue(
			new Error(`${state} profile customer-a at managed path`),
		);

		const checks = await runDoctor(config);

		expect(checks).toContainEqual(
			expect.objectContaining({
				message: expect.stringContaining(state),
				name: "auth-profile",
				status: "fail",
			}),
		);
		expect(mocks.prepareShopifySession).not.toHaveBeenCalled();
	});

	it("reports stale isolated Admin state and closes the probe", async () => {
		const close = vi.fn(async () => undefined);
		mocks.prepareShopifySession.mockResolvedValue({
			close,
			page: { url: () => "https://accounts.shopify.com/login" },
		});

		const checks = await runDoctor(config);

		expect(checks).toContainEqual(
			expect.objectContaining({
				name: "shopify-session",
				status: "warn",
			}),
		);
		expect(close).toHaveBeenCalledOnce();
	});

	it("reports an isolated probe failure instead of crashing doctor", async () => {
		mocks.prepareShopifySession.mockRejectedValue(
			new Error("isolated navigation failed"),
		);

		const checks = await runDoctor(config);

		expect(checks).toContainEqual(
			expect.objectContaining({
				message: expect.stringContaining("isolated navigation failed"),
				name: "shopify-session",
				status: "warn",
			}),
		);
	});

	it("reports a ready selected profile from one closed isolated probe", async () => {
		const close = vi.fn(async () => undefined);
		mocks.prepareShopifySession.mockResolvedValue({
			close,
			page: { url: () => "https://admin.shopify.com/store/example" },
		});

		const checks = await runDoctor(config);

		expect(checks).toContainEqual(
			expect.objectContaining({
				message: expect.stringContaining("customer-a"),
				name: "shopify-session",
				status: "pass",
			}),
		);
		expect(close).toHaveBeenCalledOnce();
	});
});
