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
		expect("createLiveShopifyPage" in api).toBe(false);
		expect("buildCartPermalinkUrl" in api).toBe(false);
		expect("slowFill" in api).toBe(false);
	});

	it("keeps advanced helpers available through explicit subpath entrypoints", () => {
		expect(configApi.resolveShopifyE2EConfig).toBeTypeOf("function");
		expect(configApi.missingLiveShopifyPrerequisites).toBeTypeOf(
			"function",
		);
		expect(playwrightApi.createLiveShopifyPage).toBeTypeOf("function");
		expect(playwrightApi.globalSetup).toBeTypeOf("function");
		expect(storefrontApi.ensureStorefrontUnlocked).toBeTypeOf("function");
		expect(storefrontApi.resolveStorefrontVariantId).toBeTypeOf("function");
		expect(storefrontApi.buildCartPermalinkUrl).toBeTypeOf("function");
		expect(storefrontApi.gotoCartPermalink).toBeTypeOf("function");
		expect(inputApi.slowFill).toBeTypeOf("function");
		expect(inputApi.firstUsableLocator).toBeTypeOf("function");
		expect(urlApi.adminStoreUrl).toBeTypeOf("function");
	});
});
