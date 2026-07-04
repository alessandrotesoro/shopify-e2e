import { describe, expect, it, vi } from "vitest";

import type { ResolvedShopifyE2EConfig } from "../src/shopify-e2e-config.js";

const mocks = vi.hoisted(() => ({
	createSessionPage: vi.fn(),
	resolveShopifyE2EConfig: vi.fn(),
}));

vi.mock("../src/shopify-e2e-config.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/shopify-e2e-config.js")>();

	return {
		...actual,
		resolveShopifyE2EConfig: mocks.resolveShopifyE2EConfig,
	};
});

vi.mock("../src/shopify-session.js", () => ({
	createLiveShopifyPage: mocks.createSessionPage,
	gotoLiveShopifyPage: vi.fn(),
	openLiveShopifyPage: vi.fn(),
}));

const { createLiveShopifyPage } = await import(
	"../src/playwright/live-shopify-page.js"
);

const resolvedConfig: ResolvedShopifyE2EConfig = {
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

describe("live Shopify Playwright helpers", () => {
	it("resolves partial config options before opening the shared page", async () => {
		const partialConfig = {
			authStatePath: "/tmp/custom-auth.json",
			cdpUrl: "http://127.0.0.1:9333",
		};
		const livePage = { page: {} };

		mocks.resolveShopifyE2EConfig.mockResolvedValue(resolvedConfig);
		mocks.createSessionPage.mockResolvedValue(livePage);

		await expect(createLiveShopifyPage(partialConfig)).resolves.toBe(
			livePage,
		);
		expect(mocks.resolveShopifyE2EConfig).toHaveBeenCalledWith(
			partialConfig,
		);
		expect(mocks.createSessionPage).toHaveBeenCalledWith(resolvedConfig);
	});

	it("uses already resolved config objects without resolving them again", async () => {
		const livePage = { page: {} };

		mocks.resolveShopifyE2EConfig.mockReset();
		mocks.createSessionPage.mockResolvedValue(livePage);

		await expect(createLiveShopifyPage(resolvedConfig)).resolves.toBe(
			livePage,
		);
		expect(mocks.resolveShopifyE2EConfig).not.toHaveBeenCalled();
		expect(mocks.createSessionPage).toHaveBeenCalledWith(resolvedConfig);
	});
});
