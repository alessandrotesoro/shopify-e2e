import type { Page } from "playwright-core";

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
	createLiveShopifyPage,
	gotoLiveShopifyPage,
	type PreparedShopifySession,
	type PrepareShopifySessionOptions,
	prepareShopifySession,
} from "./shopify-session.js";
import { adminStoreUrl } from "./urls.js";

export type { ShopifyE2EConfigInput };

export interface ShopifyE2E {
	admin: ShopifyE2EAdmin;
	checkout: ShopifyE2ECheckout;
	config: ResolvedShopifyE2EConfig;
	inputs: ShopifyE2EInputs;
	storefront: ShopifyE2EStorefront;
}

export interface ShopifyE2EAdmin {
	goto(pathOrUrl?: string): Promise<Page>;
	open(pathOrUrl?: string): Promise<Page>;
	page(): Promise<Page>;
	prepare(
		options?: PrepareShopifySessionOptions,
	): Promise<PreparedShopifySession>;
}

export interface ShopifyE2EStorefront {
	unlock(options?: ShopifyE2EPageOptions): Promise<boolean>;
	variantId(
		product: StorefrontProductInput,
		options?: ShopifyE2EPageOptions,
	): Promise<string>;
}

export interface ShopifyE2ECheckout {
	cartUrl(options: ShopifyE2ECartOptions): string;
	openCart(options: ShopifyE2EOpenCartOptions): Promise<Page>;
}

export interface ShopifyE2EPageOptions extends SlowInputOptions {
	page?: Page;
}

export interface ShopifyE2ECartOptions {
	buyer?: ShopifyCheckoutBuyer;
	quantity?: number;
	variantId: number | string;
}

export interface ShopifyE2EOpenCartOptions extends ShopifyE2ECartOptions {
	page?: Page;
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
	const adminPage = async (): Promise<Page> =>
		(await createLiveShopifyPage(resolvedConfig)).page;
	const gotoAdminPage = async (pathOrUrl?: string): Promise<Page> => {
		const page = await adminPage();

		await gotoLiveShopifyPage(page, adminUrl(resolvedConfig, pathOrUrl));

		return page;
	};
	const admin: ShopifyE2EAdmin = {
		goto: gotoAdminPage,
		open: gotoAdminPage,
		page: adminPage,
		prepare: async (options) =>
			prepareShopifySession(resolvedConfig, options),
	};

	return {
		admin,
		checkout: {
			cartUrl: (options) =>
				buildCartPermalinkUrl({
					config: resolvedConfig,
					...options,
				}),
			openCart: async ({ page, ...options }) => {
				const targetPage = page ?? (await admin.page());

				await gotoCartPermalink({
					config: resolvedConfig,
					page: targetPage,
					...options,
				});

				return targetPage;
			},
		},
		config: resolvedConfig,
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
				const targetPage = options.page ?? (await admin.page());

				return ensureStorefrontUnlocked({
					...options,
					config: resolvedConfig,
					page: targetPage,
				});
			},
			variantId: async (product, options = {}) => {
				const targetPage = options.page ?? (await admin.page());

				return resolveStorefrontVariantId({
					...options,
					config: resolvedConfig,
					page: targetPage,
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
