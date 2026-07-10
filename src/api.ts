import type { Page } from "playwright-core";
import {
	type CompleteShopifyCheckoutOptions,
	completeShopifyCheckout,
	expectShopifyCheckoutComplete,
	type ShopifyCheckoutCompletion,
	type ShopifyCheckoutPhaseReporter,
	type ShopifyCheckoutPhaseTiming,
} from "./playwright/checkout.js";
import {
	clickFirstVisibleButton,
	fillFirstVisible,
	firstUsableLocator,
	isUsable,
	type SlowInputOptions,
	selectFirstVisible,
	slowClick,
	slowFill,
	slowSelect,
} from "./playwright/inputs.js";
import {
	buildCartPermalinkUrl,
	ensureStorefrontUnlocked,
	gotoCartPermalink,
	resolveStorefrontVariantId,
	type ShopifyCheckoutBuyer,
	type StorefrontProductInput,
} from "./playwright/storefront.js";
import type { ShopifyE2EConfigInput } from "./resolve-config.js";
import { resolveConfigInput } from "./resolve-config.js";
import type { ResolvedShopifyE2EConfig } from "./shopify-e2e-config.js";
import {
	createShopifyRuntimeSession,
	gotoLiveShopifyPage,
} from "./shopify-session.js";
import { adminStoreUrl } from "./urls.js";

export type { ShopifyE2EConfigInput };

export interface ShopifyE2E {
	admin: ShopifyE2EAdmin;
	checkout: ShopifyE2ECheckout;
	close(): Promise<void>;
	config: ResolvedShopifyE2EConfig;
	inputs: ShopifyE2EInputs;
	storefront: ShopifyE2EStorefront;
}

export interface ShopifyE2EAdmin {
	goto(pathOrUrl?: string): Promise<Page>;
	open(pathOrUrl?: string): Promise<Page>;
	page(): Promise<Page>;
}

export interface ShopifyE2EStorefront {
	unlock(options?: ShopifyE2EStorefrontOptions): Promise<boolean>;
	variantId(
		product: StorefrontProductInput,
		options?: ShopifyE2EStorefrontOptions,
	): Promise<string>;
}

export interface ShopifyE2ECheckout {
	cartUrl(options: ShopifyE2ECartOptions): string;
	complete(
		options?: ShopifyE2ECompleteCheckoutOptions,
	): Promise<ShopifyCheckoutCompletion>;
	expectComplete(options?: ShopifyE2EExpectCompleteOptions): Promise<void>;
	openCart(options: ShopifyE2EOpenCartOptions): Promise<Page>;
	purchase(
		options: ShopifyE2EPurchaseOptions,
	): Promise<ShopifyE2EPurchaseResult>;
}

export type ShopifyE2EStorefrontOptions = SlowInputOptions;

export interface ShopifyE2ECartOptions {
	buyer?: ShopifyCheckoutBuyer;
	quantity?: number;
	variantId: number | string;
}

export interface ShopifyE2EOpenCartOptions extends ShopifyE2ECartOptions {
	phaseReporter?: ShopifyCheckoutPhaseReporter;
}

export interface ShopifyE2ECompleteCheckoutOptions
	extends Omit<CompleteShopifyCheckoutOptions, "page"> {}

export interface ShopifyE2EExpectCompleteOptions {
	timeoutMs?: number;
}

export interface ShopifyE2EPurchaseOptions
	extends ShopifyE2ECartOptions,
		Omit<ShopifyE2ECompleteCheckoutOptions, "buyer"> {}

export interface ShopifyE2EPurchaseResult extends ShopifyCheckoutCompletion {
	page: Page;
}

export interface ShopifyE2EInputs {
	clickFirstVisibleButton: typeof clickFirstVisibleButton;
	fillFirstVisible: typeof fillFirstVisible;
	firstUsableLocator: typeof firstUsableLocator;
	isUsable: typeof isUsable;
	selectFirstVisible: typeof selectFirstVisible;
	slowClick: typeof slowClick;
	slowFill: typeof slowFill;
	slowSelect: typeof slowSelect;
}

export async function createShopifyE2E(
	config?: ShopifyE2EConfigInput,
): Promise<ShopifyE2E> {
	const resolvedConfig = await resolveConfigInput(config);
	const runtimeSession = createShopifyRuntimeSession(resolvedConfig);
	const clientConfig = runtimeSession.config;
	const adminPage = (): Promise<Page> => runtimeSession.page();
	let closePromise: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closePromise ??= runtimeSession.close();

		return closePromise;
	};
	const gotoAdminPage = async (pathOrUrl?: string): Promise<Page> => {
		const page = await adminPage();

		await gotoLiveShopifyPage(page, adminUrl(clientConfig, pathOrUrl));

		return page;
	};
	const admin: ShopifyE2EAdmin = {
		goto: gotoAdminPage,
		open: gotoAdminPage,
		page: adminPage,
	};
	const openCart = async ({
		phaseReporter,
		...options
	}: ShopifyE2EOpenCartOptions): Promise<Page> => {
		const targetPage = await admin.page();
		const startedAt = performance.now();

		await gotoCartPermalink({
			...options,
			config: clientConfig,
			page: targetPage,
		});
		phaseReporter?.({
			durationMs: performance.now() - startedAt,
			phase: "checkout.entry",
		});

		return targetPage;
	};
	const complete = async (
		options: ShopifyE2ECompleteCheckoutOptions = {},
	): Promise<ShopifyCheckoutCompletion> =>
		completeShopifyCheckout({
			...options,
			page: await admin.page(),
		});
	const expectComplete = async (
		options: ShopifyE2EExpectCompleteOptions = {},
	): Promise<void> =>
		expectShopifyCheckoutComplete(await admin.page(), {
			timeoutMs: options.timeoutMs,
		});
	const purchase = async ({
		quantity,
		variantId,
		...options
	}: ShopifyE2EPurchaseOptions): Promise<ShopifyE2EPurchaseResult> => {
		const targetPage = await admin.page();
		const entryTimings: ShopifyCheckoutPhaseTiming[] = [];

		await openCart({
			buyer: options.buyer,
			phaseReporter: (timing) => {
				entryTimings.push(timing);
				options.phaseReporter?.(timing);
			},
			quantity,
			variantId,
		});
		const completion = await complete({
			...options,
		});

		return {
			...completion,
			page: targetPage,
			timings: [...entryTimings, ...completion.timings],
		};
	};

	return {
		admin,
		checkout: {
			cartUrl: (options) =>
				buildCartPermalinkUrl({
					...options,
					config: clientConfig,
				}),
			complete,
			expectComplete,
			openCart,
			purchase,
		},
		close,
		config: clientConfig,
		inputs: {
			clickFirstVisibleButton,
			fillFirstVisible,
			firstUsableLocator,
			isUsable,
			selectFirstVisible,
			slowClick,
			slowFill,
			slowSelect,
		},
		storefront: {
			unlock: async (options = {}) => {
				return ensureStorefrontUnlocked({
					...options,
					config: clientConfig,
					page: await admin.page(),
				});
			},
			variantId: async (product, options = {}) => {
				return resolveStorefrontVariantId({
					...options,
					config: clientConfig,
					page: await admin.page(),
					product,
				});
			},
		},
	};
}

function adminUrl(
	config: ResolvedShopifyE2EConfig,
	pathOrUrl: string | undefined,
): string {
	if (!pathOrUrl) {
		return adminStoreUrl(requireShopDomain(config));
	}

	if (isAbsoluteUrl(pathOrUrl)) {
		return pathOrUrl;
	}

	const base = `${adminStoreUrl(requireShopDomain(config))}/`;
	const path = pathOrUrl.replace(/^\/+/, "");

	return new URL(path, base).toString();
}

function requireShopDomain(config: ResolvedShopifyE2EConfig): string {
	if (!config.shopDomain) {
		throw new Error("Missing SHOPIFY_E2E_SHOP_DOMAIN.");
	}

	return config.shopDomain;
}

function isAbsoluteUrl(value: string): boolean {
	try {
		new URL(value);

		return true;
	} catch {
		return false;
	}
}
