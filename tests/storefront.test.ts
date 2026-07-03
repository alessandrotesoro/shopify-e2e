import { describe, expect, it, vi } from "vitest";

import {
	buildCartPermalinkUrl,
	ensureStorefrontUnlocked,
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
			buildCartPermalinkUrl("12345", config, {
				address1: "500 7th Avenue",
				city: "New York",
				countryCode: "US",
				email: "buyer@example.com",
				firstName: "Ada",
				lastName: "Lovelace",
				phone: "5555555555",
				postalCode: "10018",
				provinceCode: "NY",
			}),
		);

		expect(url.origin).toBe("https://example.myshopify.com");
		expect(url.pathname).toBe("/cart/12345:1");
		expect(url.searchParams.get("checkout[email]")).toBe("buyer@example.com");
		expect(url.searchParams.get("checkout[shipping_address][province]")).toBe(
			"NY",
		);
	});

	it("returns explicit variant IDs without storefront navigation", async () => {
		const page = pageDouble();

		await expect(
			resolveStorefrontVariantId(page as never, { variantId: 9988 }, config, {
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
			resolveStorefrontVariantId(
				page as never,
				{ handle: "digital-download" },
				{ shopDomain: config.shopDomain },
				{ actionDelayMs: 0, inputDelayMs: 0 },
			),
		).resolves.toBe("222");
		expect(page.goto).toHaveBeenCalledWith(
			"https://example.myshopify.com/products/digital-download.js",
			{ waitUntil: "domcontentloaded" },
		);
	});

	it("unlocks password-protected storefronts", async () => {
		const page = pageDouble({ currentUrl: "https://example.myshopify.com/password" });

		await expect(
			ensureStorefrontUnlocked(page as never, config, {
				actionDelayMs: 0,
				inputDelayMs: 0,
			}),
		).resolves.toBe(true);
		expect(page.goto).toHaveBeenCalledWith(
			"https://example.myshopify.com/password",
			{ waitUntil: "domcontentloaded" },
		);
		expect(page.passwordLocator.pressSequentially).toHaveBeenCalledWith("secret", {
			delay: 0,
		});
		expect(page.submitButton.click).toHaveBeenCalledWith({ delay: 0 });
	});

	it("detects storefront password pages", () => {
		expect(isStorefrontPasswordPage("https://example.myshopify.com/password")).toBe(
			true,
		);
		expect(isStorefrontPasswordPage("https://example.myshopify.com/products/a")).toBe(
			false,
		);
		expect(isStorefrontPasswordPage("not a url")).toBe(false);
	});
});

function pageDouble(
	options: { bodyText?: string; currentUrl?: string } = {},
) {
	const state = {
		currentUrl: options.currentUrl ?? "about:blank",
	};
	const bodyLocator = {
		innerText: vi.fn(async () => options.bodyText ?? "{}"),
	};
	const passwordLocator = locatorDouble();
	const submitButton = locatorDouble();

	return {
		get passwordLocator() {
			return passwordLocator;
		},
		get submitButton() {
			return submitButton;
		},
		frames: vi.fn(() => []),
		getByRole: vi.fn(() => ({
			first: () => submitButton,
		})),
		goto: vi.fn(async (url: string) => {
			state.currentUrl = url;
		}),
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
}

function locatorDouble() {
	return {
		click: vi.fn(async () => undefined),
		count: vi.fn(async () => 1),
		fill: vi.fn(async () => undefined),
		focus: vi.fn(async () => undefined),
		inputValue: vi.fn(async () => ""),
		isEnabled: vi.fn(async () => true),
		isVisible: vi.fn(async () => true),
		pressSequentially: vi.fn(async () => undefined),
		scrollIntoViewIfNeeded: vi.fn(async () => undefined),
	};
}
