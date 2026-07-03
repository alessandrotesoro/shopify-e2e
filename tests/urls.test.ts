import { describe, expect, it } from "vitest";

import {
	adminStoreUrl,
	devtoolsListUrl,
	devtoolsVersionUrl,
	isShopifyAdminUrl,
	isShopifyLoginUrl,
	legacyAdminUrl,
	shopSlug,
} from "../src/urls.js";

describe("Shopify URL helpers", () => {
	it("derives admin URLs from myshopify domains", () => {
		expect(shopSlug("levelogy-development.myshopify.com")).toBe(
			"levelogy-development",
		);
		expect(adminStoreUrl("levelogy-development.myshopify.com")).toBe(
			"https://admin.shopify.com/store/levelogy-development",
		);
		expect(legacyAdminUrl("levelogy-development.myshopify.com")).toBe(
			"https://levelogy-development.myshopify.com/admin",
		);
	});

	it("detects modern and legacy Shopify Admin URLs", () => {
		expect(
			isShopifyAdminUrl(
				"https://admin.shopify.com/store/levelogy-development/apps/test",
				"levelogy-development.myshopify.com",
			),
		).toBe(true);
		expect(
			isShopifyAdminUrl(
				"https://levelogy-development.myshopify.com/admin/apps/test",
				"levelogy-development.myshopify.com",
			),
		).toBe(true);
		expect(
			isShopifyAdminUrl(
				"https://admin.shopify.com/store/other",
				"levelogy-development.myshopify.com",
			),
		).toBe(false);
	});

	it("detects login and challenge URLs", () => {
		expect(isShopifyLoginUrl("https://accounts.shopify.com/login")).toBe(true);
		expect(
			isShopifyLoginUrl("https://admin.shopify.com/store/example/challenge"),
		).toBe(true);
		expect(isShopifyLoginUrl("https://admin.shopify.com/store/example")).toBe(
			false,
		);
	});

	it("normalizes websocket CDP URLs to HTTP devtools endpoints", () => {
		expect(devtoolsVersionUrl("ws://127.0.0.1:9222/devtools/browser/id")).toBe(
			"http://127.0.0.1:9222/json/version",
		);
		expect(devtoolsListUrl("http://127.0.0.1:9222")).toBe(
			"http://127.0.0.1:9222/json/list",
		);
	});
});
