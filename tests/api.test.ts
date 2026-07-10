import type { Page } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
	ShopifyE2E,
	ShopifyE2ECompleteCheckoutOptions,
	ShopifyE2EExpectCompleteOptions,
	ShopifyE2EOpenCartOptions,
	ShopifyE2EPurchaseOptions,
} from "../src/api.js";
import type { ShopifyCheckoutPhaseTiming } from "../src/playwright/checkout.js";
import type { ResolvedShopifyE2EConfig } from "../src/shopify-e2e-config.js";
import type { ShopifyRuntimeSession } from "../src/shopify-session.js";

const mocks = vi.hoisted(() => ({
	buildCartPermalinkUrl: vi.fn(() => "https://store.test/cart/123:1"),
	completeShopifyCheckout: vi.fn(),
	createShopifyRuntimeSession: vi.fn(),
	ensureStorefrontUnlocked: vi.fn(),
	expectShopifyCheckoutComplete: vi.fn(),
	gotoCartPermalink: vi.fn(),
	gotoLiveShopifyPage: vi.fn(),
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
		createShopifyRuntimeSession: mocks.createShopifyRuntimeSession,
		gotoLiveShopifyPage: mocks.gotoLiveShopifyPage,
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

const page = { id: "owned" } as unknown as Page;
const unmanagedPage = { id: "unmanaged" } as unknown as Page;
const config = resolvedConfig("customer-a");

describe("createShopifyE2E", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.buildCartPermalinkUrl.mockReturnValue(
			"https://store.test/cart/123:1",
		);
		mocks.createShopifyRuntimeSession.mockImplementation((resolvedConfig) =>
			runtimeSession(resolvedConfig),
		);
	});

	it("resolves config once and binds the selected profile to one session", async () => {
		mocks.resolveShopifyE2EConfig.mockResolvedValue(config);
		const sessionConfig = Object.freeze({
			...config,
			authProfile: Object.freeze({ ...config.authProfile }),
		});
		mocks.createShopifyRuntimeSession.mockReturnValue(
			runtimeSession(sessionConfig),
		);

		const shopify = await createShopifyE2E({ authProfile: "customer-a" });

		try {
			expect(shopify.config).toBe(sessionConfig);
			expect(shopify.admin).toBeTypeOf("object");
			expect(shopify.storefront).toBeTypeOf("object");
			expect(shopify.checkout).toBeTypeOf("object");
			expect(shopify.inputs.slowFill).toBe(mocks.slowFill);
			expect(mocks.resolveShopifyE2EConfig).toHaveBeenCalledOnce();
			expect(mocks.resolveShopifyE2EConfig).toHaveBeenCalledWith({
				authProfile: "customer-a",
			});
			expect(mocks.createShopifyRuntimeSession).toHaveBeenCalledOnce();
			expect(mocks.createShopifyRuntimeSession).toHaveBeenCalledWith(
				config,
			);
		} finally {
			await shopify.close();
		}
	});

	it("uses the one session-owned page for every high-level method", async () => {
		mocks.resolveShopifyE2EConfig.mockResolvedValue(config);
		mocks.completeShopifyCheckout.mockResolvedValue({
			diagnostics: { usedPaymentFrameFallback: false },
			submitted: true,
			timings: [],
		});
		mocks.resolveStorefrontVariantId.mockResolvedValue("123");
		const shopify = await createShopifyE2E();

		try {
			const buyer = { email: "buyer@example.com" };
			expect(shopify.checkout.cartUrl({ buyer, variantId: 123 })).toBe(
				"https://store.test/cart/123:1",
			);
			expect(mocks.buildCartPermalinkUrl).toHaveBeenLastCalledWith({
				buyer,
				config,
				variantId: 123,
			});

			await expect(shopify.admin.page()).resolves.toBe(page);
			await expect(shopify.admin.goto("/products")).resolves.toBe(page);
			expect(mocks.gotoLiveShopifyPage).toHaveBeenLastCalledWith(
				page,
				"https://admin.shopify.com/store/example/products",
			);

			await expect(shopify.admin.open()).resolves.toBe(page);
			expect(mocks.gotoLiveShopifyPage).toHaveBeenLastCalledWith(
				page,
				"https://admin.shopify.com/store/example",
			);

			await shopify.storefront.unlock({
				page: unmanagedPage,
			} as unknown as Parameters<typeof shopify.storefront.unlock>[0]);
			expect(mocks.ensureStorefrontUnlocked).toHaveBeenLastCalledWith({
				config,
				page,
			});

			await expect(
				shopify.storefront.variantId({ handle: "test-product" }, {
					page: unmanagedPage,
				} as unknown as Parameters<
					typeof shopify.storefront.variantId
				>[1]),
			).resolves.toBe("123");
			expect(mocks.resolveStorefrontVariantId).toHaveBeenLastCalledWith({
				config,
				page,
				product: { handle: "test-product" },
			});

			const entryTimings: ShopifyCheckoutPhaseTiming[] = [];
			await expect(
				shopify.checkout.openCart({
					buyer,
					page: unmanagedPage,
					phaseReporter: (timing: ShopifyCheckoutPhaseTiming) =>
						entryTimings.push(timing),
					variantId: 123,
				} as unknown as ShopifyE2EOpenCartOptions),
			).resolves.toBe(page);
			expect(mocks.gotoCartPermalink).toHaveBeenLastCalledWith({
				buyer,
				config,
				page,
				variantId: 123,
			});
			expect(entryTimings.map(({ phase }) => phase)).toEqual([
				"checkout.entry",
			]);

			await shopify.checkout.complete({
				page: unmanagedPage,
			} as unknown as ShopifyE2ECompleteCheckoutOptions);
			expect(mocks.completeShopifyCheckout).toHaveBeenLastCalledWith({
				page,
			});

			await shopify.checkout.expectComplete({
				page: unmanagedPage,
				timeoutMs: 123,
			} as unknown as ShopifyE2EExpectCompleteOptions);
			expect(
				mocks.expectShopifyCheckoutComplete,
			).toHaveBeenLastCalledWith(page, { timeoutMs: 123 });

			await expect(
				shopify.checkout.purchase({
					buyer,
					page: unmanagedPage,
					variantId: 123,
				} as unknown as ShopifyE2EPurchaseOptions),
			).resolves.toMatchObject({ page });
			expect(mocks.gotoCartPermalink).toHaveBeenLastCalledWith({
				buyer,
				config,
				page,
				variantId: 123,
			});
			expect(mocks.completeShopifyCheckout).toHaveBeenLastCalledWith(
				expect.objectContaining({ buyer, page }),
			);
			expect(unmanagedPage).not.toBe(page);
		} finally {
			await shopify.close();
		}
	});

	it("does not expose unmanaged page or prepare options in the high-level API", async () => {
		mocks.resolveShopifyE2EConfig.mockResolvedValue(config);
		const shopify = await createShopifyE2E();

		try {
			expect("prepare" in shopify.admin).toBe(false);

			expect(assertHighLevelPageOverridesRejected).toBeTypeOf("function");
		} finally {
			await shopify.close();
		}
	});

	it("delegates close once and remains repeatable", async () => {
		mocks.resolveShopifyE2EConfig.mockResolvedValue(config);
		const close = vi.fn().mockResolvedValue(undefined);
		mocks.createShopifyRuntimeSession.mockReturnValue(
			runtimeSession(config, { close }),
		);
		const shopify = await createShopifyE2E();

		await Promise.all([shopify.close(), shopify.close()]);
		await shopify.close();

		expect(close).toHaveBeenCalledOnce();
	});

	it("allows profile B only after profile A closes", async () => {
		const configA = resolvedConfig("customer-a");
		const configB = resolvedConfig("customer-b");
		let active = false;

		mocks.resolveShopifyE2EConfig.mockImplementation(
			async ({ authProfile }) =>
				authProfile === "customer-b" ? configB : configA,
		);
		mocks.createShopifyRuntimeSession.mockImplementation(
			(resolvedConfig) => {
				if (active) {
					throw new Error("runtime session already active");
				}

				active = true;

				return runtimeSession(resolvedConfig, {
					close: vi.fn(async () => {
						active = false;
					}),
				});
			},
		);

		const shopifyA = await createShopifyE2E({ authProfile: "customer-a" });
		await expect(
			createShopifyE2E({ authProfile: "customer-b" }),
		).rejects.toThrow("runtime session already active");

		await shopifyA.close();
		const shopifyB = await createShopifyE2E({ authProfile: "customer-b" });

		try {
			expect(shopifyB.config.authProfile.name).toBe("customer-b");
		} finally {
			await shopifyB.close();
		}
	});

	it("can close through finally after an ordinary assertion failure", async () => {
		mocks.resolveShopifyE2EConfig.mockResolvedValue(config);
		const close = vi.fn().mockResolvedValue(undefined);
		mocks.createShopifyRuntimeSession.mockReturnValue(
			runtimeSession(config, { close }),
		);

		await expect(
			(async () => {
				const shopify = await createShopifyE2E();

				try {
					throw new Error("ordinary assertion failed");
				} finally {
					await shopify.close();
				}
			})(),
		).rejects.toThrow("ordinary assertion failed");
		expect(close).toHaveBeenCalledOnce();
	});
});

function resolvedConfig(profileName: string): ResolvedShopifyE2EConfig {
	return {
		appUrl: "https://app.test",
		authProfile: {
			name: profileName,
			storageStatePath: `/tmp/.shopify-e2e/auth/profiles/${profileName}.json`,
		},
		cdpPort: "9222",
		cdpUrl: "http://127.0.0.1:9222",
		chromeProfilePath: "/tmp/.shopify-e2e/chrome-profile",
		cwd: "/tmp",
		live: true,
		shopDomain: "example.myshopify.com",
		testCommand: {
			args: ["playwright", "test"],
			command: "npx",
		},
		testFiles: [],
	};
}

function runtimeSession(
	resolvedConfig: ResolvedShopifyE2EConfig,
	overrides: Partial<ShopifyRuntimeSession> = {},
): ShopifyRuntimeSession {
	return {
		authProfile: resolvedConfig.authProfile,
		close: vi.fn().mockResolvedValue(undefined),
		config: resolvedConfig,
		page: vi.fn().mockResolvedValue(page),
		...overrides,
	};
}

async function assertHighLevelPageOverridesRejected(
	shopify: ShopifyE2E,
	page: Page,
): Promise<void> {
	// @ts-expect-error High-level Admin preparation is not part of the runtime API.
	await shopify.admin.prepare();
	// @ts-expect-error High-level storefront methods cannot accept a page.
	await shopify.storefront.unlock({ page });
	await shopify.storefront.variantId(
		{ variantId: 123 },
		// @ts-expect-error High-level storefront methods cannot accept a page.
		{ page },
	);
	// @ts-expect-error High-level checkout methods cannot accept a page.
	await shopify.checkout.openCart({ page, variantId: 123 });
	// @ts-expect-error High-level checkout methods cannot accept a page.
	await shopify.checkout.complete({ page });
	// @ts-expect-error High-level checkout methods cannot accept a page.
	await shopify.checkout.expectComplete({ page });
	// @ts-expect-error High-level checkout methods cannot accept a page.
	await shopify.checkout.purchase({ page, variantId: 123 });
}
