import type { Page } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedShopifyE2EConfig } from "../src/shopify-e2e-config.js";

const mocks = vi.hoisted(() => ({
	buildCartPermalinkUrl: vi.fn(() => "https://store.test/cart/123:1"),
	completeShopifyCheckout: vi.fn(),
	createLiveShopifyPage: vi.fn(),
	ensureStorefrontUnlocked: vi.fn(),
	expectShopifyCheckoutComplete: vi.fn(),
	gotoCartPermalink: vi.fn(),
	gotoLiveShopifyPage: vi.fn(),
	prepareShopifySession: vi.fn(),
	resolveShopifyE2EConfig: vi.fn(),
	resolveStorefrontVariantId: vi.fn(),
	slowFill: vi.fn(),
}));

vi.mock("../src/shopify-e2e-config.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/shopify-e2e-config.js")>();

	return {
		...actual,
		resolveShopifyE2EConfig: mocks.resolveShopifyE2EConfig,
	};
});

vi.mock("../src/shopify-session.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/shopify-session.js")>();

	return {
		...actual,
		createLiveShopifyPage: mocks.createLiveShopifyPage,
		gotoLiveShopifyPage: mocks.gotoLiveShopifyPage,
		prepareShopifySession: mocks.prepareShopifySession,
	};
});

vi.mock("../src/playwright/storefront.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../src/playwright/storefront.js")
		>();

	return {
		...actual,
		buildCartPermalinkUrl: mocks.buildCartPermalinkUrl,
		ensureStorefrontUnlocked: mocks.ensureStorefrontUnlocked,
		gotoCartPermalink: mocks.gotoCartPermalink,
		resolveStorefrontVariantId: mocks.resolveStorefrontVariantId,
	};
});

vi.mock("../src/playwright/inputs.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/playwright/inputs.js")>();

	return {
		...actual,
		slowFill: mocks.slowFill,
	};
});

vi.mock("../src/playwright/checkout.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/playwright/checkout.js")>();

	return {
		...actual,
		completeShopifyCheckout: mocks.completeShopifyCheckout,
		expectShopifyCheckoutComplete: mocks.expectShopifyCheckoutComplete,
	};
});

const { createShopifyE2E } = await import("../src/api.js");

const page = {} as Page;
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

describe("createShopifyE2E", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.buildCartPermalinkUrl.mockReturnValue(
			"https://store.test/cart/123:1",
		);
	});

	it("resolves config once and exposes domain namespaces", async () => {
		mocks.resolveShopifyE2EConfig.mockResolvedValue(config);

		const shopify = await createShopifyE2E({
			shopDomain: config.shopDomain,
		});

		expect(shopify.config).toBe(config);
		expect(shopify.admin).toBeTypeOf("object");
		expect(shopify.storefront).toBeTypeOf("object");
		expect(shopify.checkout).toBeTypeOf("object");
		expect(shopify.inputs.slowFill).toBe(mocks.slowFill);
		expect(mocks.resolveShopifyE2EConfig).toHaveBeenCalledWith({
			shopDomain: config.shopDomain,
		});
	});

	it("uses the shared Admin page for context methods by default", async () => {
		mocks.resolveShopifyE2EConfig.mockResolvedValue(config);
		mocks.createLiveShopifyPage.mockResolvedValue({ context: {}, page });
		mocks.completeShopifyCheckout.mockResolvedValue({
			diagnostics: { usedPaymentFrameFallback: false },
			submitted: true,
			timings: [],
		});
		mocks.resolveStorefrontVariantId.mockResolvedValue("123");

		const shopify = await createShopifyE2E();

		await expect(shopify.admin.goto("/products")).resolves.toBe(page);
		expect(mocks.gotoLiveShopifyPage).toHaveBeenCalledWith(
			page,
			"https://admin.shopify.com/store/example/products",
		);

		await expect(shopify.admin.open()).resolves.toBe(page);
		expect(mocks.gotoLiveShopifyPage).toHaveBeenCalledWith(
			page,
			"https://admin.shopify.com/store/example",
		);

		await expect(
			shopify.storefront.variantId({ handle: "test-product" }),
		).resolves.toBe("123");
		expect(mocks.resolveStorefrontVariantId).toHaveBeenCalledWith(
			expect.objectContaining({
				config,
				page,
				product: { handle: "test-product" },
			}),
		);

		await expect(shopify.checkout.complete()).resolves.toMatchObject({
			submitted: true,
		});
		expect(mocks.completeShopifyCheckout).toHaveBeenCalledWith({
			page,
		});

		await shopify.checkout.expectComplete({ timeoutMs: 123 });
		expect(mocks.expectShopifyCheckoutComplete).toHaveBeenCalledWith(page, {
			timeoutMs: 123,
		});
	});

	it("opens checkout cart permalinks with the resolved config", async () => {
		mocks.resolveShopifyE2EConfig.mockResolvedValue(config);

		const shopify = await createShopifyE2E(config);
		const buyer = { email: "buyer@example.com" };

		expect(shopify.checkout.cartUrl({ buyer, variantId: 123 })).toBe(
			"https://store.test/cart/123:1",
		);
		expect(mocks.buildCartPermalinkUrl).toHaveBeenCalledWith({
			buyer,
			config,
			variantId: 123,
		});

		await expect(
			shopify.checkout.openCart({ buyer, page, variantId: 123 }),
		).resolves.toBe(page);
		expect(mocks.gotoCartPermalink).toHaveBeenCalledWith({
			buyer,
			config,
			page,
			variantId: 123,
		});
		expect(mocks.resolveShopifyE2EConfig).not.toHaveBeenCalled();
	});

	it("reports cart permalink entry timing from openCart", async () => {
		mocks.resolveShopifyE2EConfig.mockResolvedValue(config);
		const shopify = await createShopifyE2E(config);
		const timings: Array<{ durationMs: number; phase: string }> = [];

		await expect(
			shopify.checkout.openCart({
				page,
				phaseReporter: (timing) => timings.push(timing),
				variantId: 123,
			}),
		).resolves.toBe(page);
		expect(timings.map((timing) => timing.phase)).toEqual([
			"checkout.entry",
		]);
	});

	it("opens and completes checkout purchases on one shared page", async () => {
		mocks.resolveShopifyE2EConfig.mockResolvedValue(config);
		mocks.createLiveShopifyPage.mockResolvedValue({ context: {}, page });
		mocks.completeShopifyCheckout.mockResolvedValue({
			diagnostics: { usedPaymentFrameFallback: true },
			submitted: true,
			timings: [],
		});
		const shopify = await createShopifyE2E(config);
		const buyer = { email: "buyer@example.com" };
		const payment = { cardNumber: "4242424242424242" };
		const timings: Array<{ durationMs: number; phase: string }> = [];

		await expect(
			shopify.checkout.purchase({
				buyer,
				payment,
				phaseReporter: (timing) => timings.push(timing),
				variantId: 123,
			}),
		).resolves.toMatchObject({
			diagnostics: { usedPaymentFrameFallback: true },
			page,
			submitted: true,
			timings: [expect.objectContaining({ phase: "checkout.entry" })],
		});
		expect(mocks.gotoCartPermalink).toHaveBeenCalledWith({
			buyer,
			config,
			page,
			variantId: 123,
		});
		expect(mocks.completeShopifyCheckout).toHaveBeenCalledWith({
			buyer,
			page,
			payment,
			phaseReporter: expect.any(Function),
		});
		expect(timings.map((timing) => timing.phase)).toContain(
			"checkout.entry",
		);
	});
});
