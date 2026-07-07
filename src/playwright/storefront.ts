import type { Locator, Page } from "playwright-core";

import { isRecord } from "../guards.js";
import type { ResolvedShopifyE2EConfig } from "../shopify-e2e-config.js";
import { storefrontUrl } from "../urls.js";
import {
	clickFirstVisibleButton,
	firstUsableLocator,
	type SlowInputOptions,
	slowFill,
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
	"shopDomain" | "storefrontDomain" | "storefrontPassword"
>;

export interface StorefrontUnlockOptions extends SlowInputOptions {
	config: StorefrontConfig;
	page: Page;
}

export interface StorefrontVariantIdOptions extends SlowInputOptions {
	config: StorefrontConfig;
	page: Page;
	product: StorefrontProductInput;
}

export interface CartPermalinkUrlOptions {
	buyer?: ShopifyCheckoutBuyer;
	config: StorefrontConfig;
	quantity?: number;
	variantId: number | string;
}

export interface CartPermalinkNavigationOptions
	extends CartPermalinkUrlOptions {
	page: Page;
}

const checkoutBuyerParams: Array<[keyof ShopifyCheckoutBuyer, string]> = [
	["email", "checkout[email]"],
	["firstName", "checkout[shipping_address][first_name]"],
	["lastName", "checkout[shipping_address][last_name]"],
	["address1", "checkout[shipping_address][address1]"],
	["city", "checkout[shipping_address][city]"],
	["provinceCode", "checkout[shipping_address][province]"],
	["countryCode", "checkout[shipping_address][country]"],
	["postalCode", "checkout[shipping_address][zip]"],
	["phone", "checkout[shipping_address][phone]"],
];

const storefrontPasswordSelectors = [
	'input[name="password"]',
	'input[type="password"]',
	'input[name="customer[password]"]',
];

const storefrontPasswordOpenButtonNames = [
	/enter using password/i,
	/enter with password/i,
	/password/i,
];

const storefrontPasswordSubmitButtonNames = [/^enter$/i, /^submit$/i];

export async function ensureStorefrontUnlocked({
	config,
	page,
	...options
}: StorefrontUnlockOptions): Promise<boolean> {
	if (!config.storefrontPassword) {
		return false;
	}

	await gotoLiveShopifyPage(page, storefrontUrlFor(config, "/password"));

	if (!isStorefrontPasswordPage(page.url())) {
		return false;
	}

	await unlockCurrentStorefrontPasswordPage(page, config, options);

	return true;
}

export async function resolveStorefrontVariantId({
	config,
	page,
	product,
	...options
}: StorefrontVariantIdOptions): Promise<string> {
	if (product.variantId) {
		return String(product.variantId);
	}

	if (!product.handle) {
		throw new Error("Provide a Shopify product handle or variant ID.");
	}

	const productUrl = storefrontUrlFor(
		config,
		`/products/${product.handle}.js`,
	);
	await gotoLiveShopifyPage(page, productUrl);

	if (isStorefrontPasswordPage(page.url())) {
		if (!config.storefrontPassword) {
			throw new Error(
				`Storefront password page blocked ${productUrl}. Set SHOPIFY_E2E_STOREFRONT_PASSWORD in your test environment.`,
			);
		}

		await unlockCurrentStorefrontPasswordPage(page, config, options);
		await gotoLiveShopifyPage(page, productUrl);

		if (isStorefrontPasswordPage(page.url())) {
			throw new Error(
				`Storefront password page blocked ${productUrl}. Check SHOPIFY_E2E_STOREFRONT_PASSWORD in your test environment.`,
			);
		}
	}

	const productJson = await readStorefrontProductJson(page, product.handle);
	const variant =
		productJson.variants?.find((entry) => entry.available !== false) ??
		productJson.variants?.[0];

	if (!variant?.id) {
		throw new Error(
			`No available variants were found for ${productJson.title}.`,
		);
	}

	return String(variant.id);
}

export async function readStorefrontProductJson(
	page: Page,
	handle: string,
): Promise<StorefrontProductJson> {
	const text = (await page.locator("body").innerText()).trim();

	try {
		const parsed = JSON.parse(text) as unknown;

		if (isStorefrontProductJson(parsed)) {
			return parsed;
		}

		throw new Error("response did not match Shopify product JSON shape");
	} catch (error) {
		throw new Error(
			`Could not read Shopify product JSON for ${handle}. Make sure the handle exists and the storefront is unlocked.`,
			{ cause: error },
		);
	}
}

export function buildCartPermalinkUrl({
	buyer = {},
	config,
	quantity = 1,
	variantId,
}: CartPermalinkUrlOptions): string {
	const url = new URL(
		storefrontUrlFor(config, `/cart/${variantId}:${quantity}`),
	);

	for (const [field, param] of checkoutBuyerParams) {
		setCheckoutParam(url, param, buyer[field]);
	}

	return url.toString();
}

export async function gotoCartPermalink({
	page,
	...options
}: CartPermalinkNavigationOptions): Promise<void> {
	await gotoLiveShopifyPage(page, buildCartPermalinkUrl(options));
}

export function isStorefrontPasswordPage(value: string): boolean {
	try {
		return new URL(value).pathname === "/password";
	} catch {
		return false;
	}
}

function storefrontUrlFor(config: StorefrontConfig, path: string): string {
	const domain = storefrontDomain(config);

	if (!domain) {
		throw new Error(
			"Missing SHOPIFY_E2E_SHOP_DOMAIN or SHOPIFY_E2E_STOREFRONT_DOMAIN.",
		);
	}

	return storefrontUrl(domain, path);
}

async function unlockCurrentStorefrontPasswordPage(
	page: Page,
	config: StorefrontConfig,
	options: SlowInputOptions,
): Promise<void> {
	const currentUrl = page.url();

	if (!isExpectedStorefrontPasswordPage(currentUrl, config)) {
		throw new Error(
			`Refusing to enter the storefront password on unexpected URL: ${currentUrl}`,
		);
	}

	if (!config.storefrontPassword) {
		throw new Error(
			"Storefront password page is visible. Set SHOPIFY_E2E_STOREFRONT_PASSWORD in your test environment.",
		);
	}

	const passwordField = await revealStorefrontPasswordForm(page, options);

	if (!passwordField) {
		throw new Error(
			"Storefront password page is visible, but no password field was found.",
		);
	}

	await slowFill(passwordField, config.storefrontPassword, options);

	const clicked = await clickFirstVisibleButton(
		page,
		storefrontPasswordSubmitButtonNames,
		options,
	);

	if (!clicked) {
		await page.keyboard.press("Enter").catch(() => undefined);
	}

	await page.waitForLoadState("domcontentloaded").catch(() => undefined);
}

async function revealStorefrontPasswordForm(
	page: Page,
	options: SlowInputOptions,
): Promise<Locator | null> {
	const visiblePasswordField = await firstUsableLocator(
		page,
		storefrontPasswordSelectors,
	);

	if (visiblePasswordField) {
		return visiblePasswordField;
	}

	const clicked = await clickFirstVisibleButton(
		page,
		storefrontPasswordOpenButtonNames,
		options,
	);

	if (!clicked) {
		return null;
	}

	await waitForStorefrontPasswordField(page);

	return firstUsableLocator(page, storefrontPasswordSelectors);
}

async function waitForStorefrontPasswordField(page: Page): Promise<void> {
	await Promise.any(
		storefrontPasswordSelectors.map((selector) =>
			page.locator(selector).first().waitFor({
				state: "visible",
				timeout: 2_500,
			}),
		),
	).catch(() => undefined);
}

function isExpectedStorefrontPasswordPage(
	value: string,
	config: StorefrontConfig,
): boolean {
	const expectedHost = storefrontDomain(config)?.toLowerCase();

	if (!expectedHost) {
		return false;
	}

	try {
		const url = new URL(value);

		return (
			url.hostname.toLowerCase() === expectedHost &&
			url.pathname === "/password"
		);
	} catch {
		return false;
	}
}

function storefrontDomain(config: StorefrontConfig): string | undefined {
	const trimmed = (config.storefrontDomain ?? config.shopDomain)?.trim();

	return trimmed ? trimmed : undefined;
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

function isStorefrontProductJson(
	value: unknown,
): value is StorefrontProductJson {
	if (!isRecord(value) || typeof value.title !== "string") {
		return false;
	}

	return (
		value.variants === undefined ||
		(Array.isArray(value.variants) &&
			value.variants.every(isStorefrontVariant))
	);
}

function isStorefrontVariant(
	value: unknown,
): value is NonNullable<StorefrontProductJson["variants"]>[number] {
	return (
		isRecord(value) &&
		(typeof value.id === "number" || typeof value.id === "string") &&
		(value.available === undefined || typeof value.available === "boolean")
	);
}
