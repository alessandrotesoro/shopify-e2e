import { describe, expect, it } from "vitest";

import * as api from "../src/index.js";

describe("public API", () => {
	it("exports the expected Playwright and config helpers", () => {
		expect(api.globalSetup).toBeTypeOf("function");
		expect(api.createLiveShopifyPage).toBeTypeOf("function");
		expect(api.openLiveShopifyPage).toBeTypeOf("function");
		expect(api.gotoLiveShopifyPage).toBeTypeOf("function");
		expect(api.resolveShopifyE2EConfig).toBeTypeOf("function");
		expect(api.missingLiveShopifyPrerequisites).toBeTypeOf("function");
		expect(api.slowFill).toBeTypeOf("function");
	});
});
