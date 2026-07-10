import { describe, expect, it, vi } from "vitest";

import type { ResolvedShopifyE2EConfig } from "../src/shopify-e2e-config.js";

const mocks = vi.hoisted(() => ({
	createSessionPage: vi.fn(),
	resolveConfigInput: vi.fn(),
}));

vi.mock("../src/resolve-config.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/resolve-config.js")>();

	return {
		...actual,
		resolveConfigInput: mocks.resolveConfigInput,
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
	authProfile: {
		name: "customer-a",
		storageStatePath: "/tmp/profiles/customer-a.json",
	},
	cdpPort: "9222",
	cdpUrl: "http://127.0.0.1:9222",
	chromeProfilePath: "/tmp/profile",
	cwd: "/tmp",
	live: true,
	shopDomain: "example.myshopify.com",
	testCommand: {
		args: ["playwright", "test"],
		command: "npx",
	},
	testFiles: [],
};

describe("live Shopify Playwright helpers", () => {
	it("resolves partial config and returns the owned close lifecycle", async () => {
		const partialConfig = {
			authProfile: "customer-a",
			cdpUrl: "http://127.0.0.1:9333",
		};
		const close = vi.fn(async () => undefined);
		const livePage = { close, context: {}, page: {} };

		mocks.resolveConfigInput.mockResolvedValue(resolvedConfig);
		mocks.createSessionPage.mockResolvedValue(livePage);

		const result = await createLiveShopifyPage(partialConfig);

		expect(result).toBe(livePage);
		expect(result.close).toBe(close);
		expect(mocks.resolveConfigInput).toHaveBeenCalledWith(partialConfig);
		expect(mocks.createSessionPage).toHaveBeenCalledWith(resolvedConfig);
	});

	it("delegates repeated close calls to an idempotent owned session", async () => {
		const close = vi.fn(async () => undefined);
		const livePage = { close, context: {}, page: {} };
		mocks.resolveConfigInput.mockResolvedValue(resolvedConfig);
		mocks.createSessionPage.mockResolvedValue(livePage);

		const result = await createLiveShopifyPage(resolvedConfig);
		await result.close();
		await result.close();

		expect(close).toHaveBeenCalledTimes(2);
	});
});
