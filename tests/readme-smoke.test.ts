import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("README", () => {
	it("documents the implemented commands and public helpers", async () => {
		const readme = await readFile("README.md", "utf8");

		for (const expected of [
			"shopify-e2e open",
			"shopify-e2e doctor",
			"shopify-e2e auth save",
			"shopify-e2e auth restore",
			"shopify-e2e run",
			"globalSetup",
			"createShopifyE2E",
			"defineShopifyE2EConfig",
			"shopify.admin.prepare",
			"shopify.storefront.variantId",
			"shopify.checkout.openCart",
		]) {
			expect(readme).toContain(expected);
		}

		expect(readme).not.toContain("FILEBEAN_E2E");
	});
});
