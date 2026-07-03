import type { Page } from "playwright-core";

import type { ResolvedShopifyE2EConfig } from "../config.js";
import { storefrontUrl } from "../urls.js";
import {
	clickFirstVisibleButton,
	fillFirstVisible,
	type SlowInputOptions,
} from "./inputs.js";
import { gotoLiveShopifyPage } from "./live-shopify-page.js";

export interface StorefrontProductInput {
	handle?: string;
	variantId?: number | string;
}

export interface StorefrontProductJson {
	title: string;
	variants?: Array<{
		available?: boolean;
		id: number | string;
	}>;
}

export interface ShopifyCheckoutBuyer {
	address1?: string;
	city?: string;
	countryCode?: string;
	email?: string;
	firstName?: string;
	lastName?: string;
	phone?: string;
	postalCode?: string;
	provinceCode?: string;
}

export type StorefrontConfig = Pick<
	ResolvedShopifyE2EConfig,
	"shopDomain" | "storefrontPassword"
>;

export async function ensureStorefrontUnlocked(
	page: Page,
	config: StorefrontConfig,
	options: SlowInputOptions = {},
): Promise<boolean> {
	if (!config.storefrontPassword) {
		return false;
	}

	await gotoLiveShopifyPage(page, storefrontUrlFor(config, "/password"));

	if (!isStorefrontPasswordPage(page.url())) {
		return false;
	}

	const filled = await fillFirstVisible(
		page,
		passwordSelectors(),
		config.storefrontPassword,
		options,
	);

	if (!filled) {
		throw new Error("Storefront password page is visible, but no password field was found.");
	}

	const clicked = await clickFirstVisibleButton(page, [/enter/i, /submit/i], options);

	if (!clicked) {
		await page.keyboard.press("Enter").catch(() => undefined);
	}

	await page.waitForLoadState("domcontentloaded").catch(() => undefined);

	return true;
}

export async function resolveStorefrontVariantId(
	page: Page,
	product: StorefrontProductInput,
	config: StorefrontConfig,
	options: SlowInputOptions = {},
): Promise<string> {
	if (product.variantId) {
		return String(product.variantId);
	}

	if (!product.handle) {
		throw new Error("Provide a Shopify product handle or variant ID.");
	}

	await ensureStorefrontUnlocked(page, config, options);

	const productUrl = storefrontUrlFor(config, `/products/${product.handle}.js`);
	await gotoLiveShopifyPage(page, productUrl);

	if (isStorefrontPasswordPage(page.url())) {
		throw new Error(
			`Storefront password page blocked ${productUrl}. Set SHOPIFY_E2E_STOREFRONT_PASSWORD in your test environment.`,
		);
	}

	const productJson = await readStorefrontProductJson(page, product.handle);
	const variant =
		productJson.variants?.find((entry) => entry.available !== false) ??
		productJson.variants?.[0];

	if (!variant?.id) {
		throw new Error(`No available variants were found for ${productJson.title}.`);
	}

	return String(variant.id);
}

export async function readStorefrontProductJson(
	page: Page,
	handle: string,
): Promise<StorefrontProductJson> {
	const text = (await page.locator("body").innerText()).trim();

	try {
		return JSON.parse(text) as StorefrontProductJson;
	} catch (error) {
		throw new Error(
			`Could not read Shopify product JSON for ${handle}. Make sure the handle exists and the storefront is unlocked.`,
			{ cause: error },
		);
	}
}

export function buildCartPermalinkUrl(
	variantId: number | string,
	config: StorefrontConfig,
	buyer: ShopifyCheckoutBuyer = {},
): string {
	const url = new URL(storefrontUrlFor(config, `/cart/${variantId}:1`));

	setCheckoutParam(url, "checkout[email]", buyer.email);
	setCheckoutParam(
		url,
		"checkout[shipping_address][first_name]",
		buyer.firstName,
	);
	setCheckoutParam(
		url,
		"checkout[shipping_address][last_name]",
		buyer.lastName,
	);
	setCheckoutParam(
		url,
		"checkout[shipping_address][address1]",
		buyer.address1,
	);
	setCheckoutParam(url, "checkout[shipping_address][city]", buyer.city);
	setCheckoutParam(
		url,
		"checkout[shipping_address][province]",
		buyer.provinceCode,
	);
	setCheckoutParam(
		url,
		"checkout[shipping_address][country]",
		buyer.countryCode,
	);
	setCheckoutParam(
		url,
		"checkout[shipping_address][zip]",
		buyer.postalCode,
	);
	setCheckoutParam(url, "checkout[shipping_address][phone]", buyer.phone);

	return url.toString();
}

export async function gotoCartPermalink(
	page: Page,
	variantId: number | string,
	config: StorefrontConfig,
	buyer: ShopifyCheckoutBuyer = {},
): Promise<void> {
	await gotoLiveShopifyPage(page, buildCartPermalinkUrl(variantId, config, buyer));
}

export function isStorefrontPasswordPage(value: string): boolean {
	try {
		return new URL(value).pathname === "/password";
	} catch {
		return false;
	}
}

function storefrontUrlFor(config: StorefrontConfig, path: string): string {
	if (!config.shopDomain) {
		throw new Error("Missing SHOPIFY_E2E_SHOP_DOMAIN.");
	}

	return storefrontUrl(config.shopDomain, path);
}

function passwordSelectors(): string[] {
	return [
		'input[name="password"]',
		'input[type="password"]',
		'input[name="customer[password]"]',
	];
}

function setCheckoutParam(
	url: URL,
	key: string,
	value: string | undefined,
): void {
	if (value) {
		url.searchParams.set(key, value);
	}
}
