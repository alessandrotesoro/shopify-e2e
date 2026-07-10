import { describe, expect, it } from "vitest";
import * as configApi from "../src/config-api.js";
import * as api from "../src/index.js";
import * as playwrightApi from "../src/playwright/index.js";
import * as inputApi from "../src/playwright/inputs.js";
import * as storefrontApi from "../src/playwright/storefront.js";
import * as urlApi from "../src/urls.js";

describe("public API", () => {
	it("keeps the root package export focused on the primary API", () => {
		expect(api.createShopifyE2E).toBeTypeOf("function");
		expect(api.defineShopifyE2EConfig).toBeTypeOf("function");
		expect(api.globalSetup).toBeTypeOf("function");
		expect(api.globalSetupPath).toMatch(/playwright[\\/]global-setup\.js$/);
		expect("createLiveShopifyPage" in api).toBe(false);
		expect("createShopifyRuntimeSession" in api).toBe(false);
		expect("buildCartPermalinkUrl" in api).toBe(false);
		expect("slowFill" in api).toBe(false);
	});

	it("keeps advanced helpers available through explicit subpath entrypoints", () => {
		expect(configApi.assertLoopbackCdpUrl).toBeTypeOf("function");
		expect(configApi.isLoopbackCdpUrl).toBeTypeOf("function");
		expect(configApi.resolveShopifyE2EConfig).toBeTypeOf("function");
		expect(configApi.missingLiveShopifyPrerequisites).toBeTypeOf(
			"function",
		);
		expect(playwrightApi.completeShopifyCheckout).toBeTypeOf("function");
		expect(playwrightApi.createLiveShopifyPage).toBeTypeOf("function");
		expect(playwrightApi.expectShopifyCheckoutComplete).toBeTypeOf(
			"function",
		);
		expect(playwrightApi.fillShopifyCheckoutFields).toBeTypeOf("function");
		expect(playwrightApi.fillShopifyCustomerFields).toBeTypeOf("function");
		expect(playwrightApi.fillShopifyPaymentFields).toBeTypeOf("function");
		expect(playwrightApi.fillShopifyShippingFields).toBeTypeOf("function");
		expect(playwrightApi.globalSetup).toBeTypeOf("function");
		expect(playwrightApi.globalSetupPath).toMatch(
			/playwright[\\/]global-setup\.js$/,
		);
		expect(storefrontApi.ensureStorefrontUnlocked).toBeTypeOf("function");
		expect(storefrontApi.resolveStorefrontVariantId).toBeTypeOf("function");
		expect(storefrontApi.buildCartPermalinkUrl).toBeTypeOf("function");
		expect(storefrontApi.gotoCartPermalink).toBeTypeOf("function");
		expect(inputApi.slowFill).toBeTypeOf("function");
		expect(inputApi.firstUsableLocator).toBeTypeOf("function");
		expect(urlApi.adminStoreUrl).toBeTypeOf("function");
	});
});
