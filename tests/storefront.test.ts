import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";

import {
	buildCartPermalinkUrl,
	ensureStorefrontUnlocked,
	gotoCartPermalink,
	isStorefrontPasswordPage,
	resolveStorefrontVariantId,
} from "../src/playwright/storefront.js";

const config = {
	shopDomain: "example.myshopify.com",
	storefrontPassword: "secret",
};

describe("storefront helpers", () => {
	it("builds Shopify cart permalinks with optional checkout buyer fields", () => {
		const url = new URL(
			buildCartPermalinkUrl({
				buyer: {
					address1: "500 7th Avenue",
					city: "New York",
					countryCode: "US",
					email: "buyer@example.com",
					firstName: "Ada",
					lastName: "Lovelace",
					phone: "5555555555",
					postalCode: "10018",
					provinceCode: "NY",
				},
				config,
				variantId: "12345",
			}),
		);

		expect(url.origin).toBe("https://example.myshopify.com");
		expect(url.pathname).toBe("/cart/12345:1");
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			"checkout[email]": "buyer@example.com",
			"checkout[shipping_address][address1]": "500 7th Avenue",
			"checkout[shipping_address][city]": "New York",
			"checkout[shipping_address][country]": "US",
			"checkout[shipping_address][first_name]": "Ada",
			"checkout[shipping_address][last_name]": "Lovelace",
			"checkout[shipping_address][phone]": "5555555555",
			"checkout[shipping_address][province]": "NY",
			"checkout[shipping_address][zip]": "10018",
		});
	});

	it("navigates Shopify cart permalinks with object options", async () => {
		const page = pageDouble();

		await gotoCartPermalink({
			buyer: {
				email: "buyer@example.com",
			},
			config,
			page,
			quantity: 2,
			variantId: "12345",
		});

		expect(page.goto).toHaveBeenCalledTimes(1);
		const call = page.goto.mock.calls[0];

		if (!call) {
			throw new Error("Expected cart permalink navigation.");
		}

		const [url, options] = call;
		const parsed = new URL(url);

		expect(parsed.origin).toBe("https://example.myshopify.com");
		expect(parsed.pathname).toBe("/cart/12345:2");
		expect(parsed.searchParams.get("checkout[email]")).toBe(
			"buyer@example.com",
		);
		expect(options).toEqual({ waitUntil: "domcontentloaded" });
	});

	it("returns explicit variant IDs without storefront navigation", async () => {
		const page = pageDouble();

		await expect(
			resolveStorefrontVariantId({
				page,
				product: { variantId: 9988 },
				config,
				actionDelayMs: 0,
				inputDelayMs: 0,
			}),
		).resolves.toBe("9988");
		expect(page.goto).not.toHaveBeenCalled();
	});

	it("resolves the first available variant from Shopify product JSON", async () => {
		const page = pageDouble({
			bodyText: JSON.stringify({
				title: "Digital download",
				variants: [
					{ available: false, id: 111 },
					{ available: true, id: 222 },
				],
			}),
		});

		await expect(
			resolveStorefrontVariantId({
				page,
				product: { handle: "digital-download" },
				config: { shopDomain: config.shopDomain },
				actionDelayMs: 0,
				inputDelayMs: 0,
			}),
		).resolves.toBe("222");
		expect(page.goto).toHaveBeenCalledWith(
			"https://example.myshopify.com/products/digital-download.js",
			{ waitUntil: "domcontentloaded" },
		);
	});

	it("throws with product context when product JSON has the wrong shape", async () => {
		const page = pageDouble({
			bodyText: JSON.stringify({
				title: "Digital download",
				variants: { id: 222 },
			}),
		});

		await expect(
			resolveStorefrontVariantId({
				page,
				product: { handle: "digital-download" },
				config: { shopDomain: config.shopDomain },
				actionDelayMs: 0,
				inputDelayMs: 0,
			}),
		).rejects.toThrow(
			"Could not read Shopify product JSON for digital-download",
		);
	});

	it("unlocks the storefront only when product JSON is password blocked", async () => {
		const page = pageDouble({
			bodyText: JSON.stringify({
				title: "Digital download",
				variants: [{ available: true, id: 222 }],
			}),
			productPasswordBlocks: 1,
		});

		await expect(
			resolveStorefrontVariantId({
				page,
				product: { handle: "digital-download" },
				config,
				actionDelayMs: 0,
				inputDelayMs: 0,
			}),
		).resolves.toBe("222");
		expect(page.goto).toHaveBeenNthCalledWith(
			1,
			"https://example.myshopify.com/products/digital-download.js",
			{ waitUntil: "domcontentloaded" },
		);
		expect(page.goto).toHaveBeenNthCalledWith(
			2,
			"https://example.myshopify.com/products/digital-download.js",
			{ waitUntil: "domcontentloaded" },
		);
		expect(page.passwordLocator.pressSequentially).toHaveBeenCalledWith(
			"secret",
			{
				delay: 0,
			},
		);
	});

	it("does not enter the storefront password on off-origin password pages", async () => {
		const page = pageDouble({
			currentUrl: "https://evil.example/password",
			productPasswordBlocks: 1,
			productPasswordUrl: "https://evil.example/password",
		});

		await expect(
			resolveStorefrontVariantId({
				page,
				product: { handle: "digital-download" },
				config,
				actionDelayMs: 0,
				inputDelayMs: 0,
			}),
		).rejects.toThrow("Refusing to enter the storefront password");
		expect(page.passwordLocator.pressSequentially).not.toHaveBeenCalled();
	});

	it("accepts configured custom storefront-domain password pages", async () => {
		const page = pageDouble({
			bodyText: JSON.stringify({
				title: "Digital download",
				variants: [{ available: true, id: 222 }],
			}),
			productPasswordBlocks: 1,
			productPasswordUrl: "https://store.example.com/password",
		});

		await expect(
			resolveStorefrontVariantId({
				page,
				product: { handle: "digital-download" },
				config: {
					...config,
					storefrontDomain: "store.example.com",
				},
				actionDelayMs: 0,
				inputDelayMs: 0,
			}),
		).resolves.toBe("222");
		expect(page.goto).toHaveBeenNthCalledWith(
			1,
			"https://store.example.com/products/digital-download.js",
			{ waitUntil: "domcontentloaded" },
		);
		expect(page.passwordLocator.pressSequentially).toHaveBeenCalledWith(
			"secret",
			{
				delay: 0,
			},
		);
	});

	it("throws when product JSON is password blocked without a configured password", async () => {
		const page = pageDouble({ productPasswordBlocks: 1 });

		await expect(
			resolveStorefrontVariantId({
				page,
				product: { handle: "digital-download" },
				config: { shopDomain: config.shopDomain },
				actionDelayMs: 0,
				inputDelayMs: 0,
			}),
		).rejects.toThrow("Set SHOPIFY_E2E_STOREFRONT_PASSWORD");
		expect(page.passwordLocator.pressSequentially).not.toHaveBeenCalled();
	});

	it("throws when product JSON is still password blocked after unlock", async () => {
		const page = pageDouble({ productPasswordBlocks: 2 });

		await expect(
			resolveStorefrontVariantId({
				page,
				product: { handle: "digital-download" },
				config,
				actionDelayMs: 0,
				inputDelayMs: 0,
			}),
		).rejects.toThrow("Check SHOPIFY_E2E_STOREFRONT_PASSWORD");
		expect(page.passwordLocator.pressSequentially).toHaveBeenCalledWith(
			"secret",
			{
				delay: 0,
			},
		);
	});

	it("unlocks password-protected storefronts", async () => {
		const page = pageDouble({
			currentUrl: "https://example.myshopify.com/password",
		});

		await expect(
			ensureStorefrontUnlocked({
				page,
				config,
				actionDelayMs: 0,
				inputDelayMs: 0,
			}),
		).resolves.toBe(true);
		expect(page.goto).toHaveBeenCalledWith(
			"https://example.myshopify.com/password",
			{ waitUntil: "domcontentloaded" },
		);
		expect(page.passwordLocator.pressSequentially).toHaveBeenCalledWith(
			"secret",
			{
				delay: 0,
			},
		);
		expect(page.submitButton.click).toHaveBeenCalledWith({ delay: 0 });
		expect(page.openPasswordButton.click).not.toHaveBeenCalled();
	});

	it("opens Shopify password modal before filling hidden password inputs", async () => {
		const page = pageDouble({
			currentUrl: "https://example.myshopify.com/password",
			passwordFieldVisible: false,
		});

		await expect(
			ensureStorefrontUnlocked({
				page,
				config,
				actionDelayMs: 0,
				inputDelayMs: 0,
			}),
		).resolves.toBe(true);
		expect(page.openPasswordButton.click).toHaveBeenCalledWith({
			delay: 0,
		});
		expect(page.passwordLocator.pressSequentially).toHaveBeenCalledWith(
			"secret",
			{
				delay: 0,
			},
		);
		expect(page.submitButton.click).toHaveBeenCalledWith({ delay: 0 });
	});

	it("detects storefront password pages", () => {
		expect(
			isStorefrontPasswordPage("https://example.myshopify.com/password"),
		).toBe(true);
		expect(
			isStorefrontPasswordPage(
				"https://example.myshopify.com/products/a",
			),
		).toBe(false);
		expect(isStorefrontPasswordPage("not a url")).toBe(false);
	});
});

interface PageDoubleOptions {
	bodyText?: string;
	currentUrl?: string;
	passwordFieldVisible?: boolean;
	productPasswordBlocks?: number;
	productPasswordUrl?: string;
}

interface PageDoubleState {
	currentUrl: string;
	passwordFieldVisible: boolean;
	productPasswordBlocks: number;
}

type StorefrontLocatorDouble = ReturnType<typeof locatorDouble>;
type StorefrontPageDouble = Page & {
	goto: ReturnType<typeof createGotoMock>;
	openPasswordButton: StorefrontLocatorDouble;
	passwordLocator: StorefrontLocatorDouble;
	submitButton: StorefrontLocatorDouble;
};

function pageDouble(options: PageDoubleOptions = {}): StorefrontPageDouble {
	const state = {
		currentUrl: options.currentUrl ?? "about:blank",
		passwordFieldVisible: options.passwordFieldVisible ?? true,
		productPasswordBlocks: options.productPasswordBlocks ?? 0,
	};
	const bodyLocator = {
		innerText: vi.fn(async () => options.bodyText ?? "{}"),
	};
	const openPasswordButton = locatorDouble({
		isVisible: () => !state.passwordFieldVisible,
		onClick: () => {
			state.passwordFieldVisible = true;
		},
	});
	const passwordLocator = locatorDouble({
		isVisible: () => state.passwordFieldVisible,
	});
	const submitButton = locatorDouble({
		isVisible: () => state.passwordFieldVisible,
	});

	const page = {
		get passwordLocator() {
			return passwordLocator;
		},
		get openPasswordButton() {
			return openPasswordButton;
		},
		get submitButton() {
			return submitButton;
		},
		frames: vi.fn(() => []),
		getByRole: vi.fn((_role: string, options?: { name?: RegExp }) => ({
			first: () =>
				shouldUseOpenPasswordButton(options?.name)
					? openPasswordButton
					: submitButton,
		})),
		goto: createGotoMock(state, options),
		keyboard: {
			press: vi.fn(async () => undefined),
		},
		locator: vi.fn((selector: string) => ({
			first: () => (selector === "body" ? bodyLocator : passwordLocator),
			innerText: bodyLocator.innerText,
		})),
		url: vi.fn(() => state.currentUrl),
		waitForLoadState: vi.fn(async () => undefined),
	};

	return page as unknown as StorefrontPageDouble;
}

function createGotoMock(state: PageDoubleState, options: PageDoubleOptions) {
	return vi.fn(async (url: string, _options?: unknown) => {
		if (state.productPasswordBlocks > 0 && url.includes("/products/")) {
			state.productPasswordBlocks -= 1;
			state.currentUrl =
				options.productPasswordUrl ??
				"https://example.myshopify.com/password";

			return null;
		}

		state.currentUrl = url;

		return null;
	});
}

function locatorDouble(
	options: { isVisible?: () => boolean; onClick?: () => void } = {},
) {
	return {
		click: vi.fn(async () => {
			options.onClick?.();
		}),
		fill: vi.fn(async () => undefined),
		focus: vi.fn(async () => undefined),
		inputValue: vi.fn(async () => ""),
		isEnabled: vi.fn(async () => true),
		isVisible: vi.fn(async () => options.isVisible?.() ?? true),
		pressSequentially: vi.fn(async () => undefined),
		scrollIntoViewIfNeeded: vi.fn(async () => undefined),
		waitFor: vi.fn(async () => {
			if (options.isVisible && !options.isVisible()) {
				throw new Error("Locator is hidden.");
			}
		}),
	};
}

function shouldUseOpenPasswordButton(name: RegExp | undefined): boolean {
	if (!name) {
		return false;
	}

	return ["enter using password", "enter with password", "password"].includes(
		name.source,
	);
}
