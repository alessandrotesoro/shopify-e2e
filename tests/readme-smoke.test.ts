import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("README", () => {
	it("documents safe named-profile commands and public helpers", async () => {
		const readme = await readFile("README.md", "utf8");

		for (const expected of [
			"shopify-e2e open",
			"shopify-e2e doctor",
			"shopify-e2e auth save --auth-profile admin-base --empty",
			"shopify-e2e auth save --auth-profile customer-a --from-auth-profile admin-base",
			"shopify-e2e open --auth-profile customer-a",
			"shopify-e2e run --auth-profile customer-a",
			"--chrome-profile-path",
			".shopify-e2e/auth/profiles/default.json",
			"SHOPIFY_E2E_AUTH_PROFILE",
			"appSetupCommand",
			"globalSetup",
			"globalSetupPath",
			"createShopifyE2E",
			"defineShopifyE2EConfig",
			'authProfile: "customer-a"',
			"await shopify.close()",
			"shopify.storefront.variantId",
			"shopify.checkout.openCart",
			"npx playwright install chromium",
			"IndexedDB",
			"sessionStorage",
			"loopback",
			"pseudonymous",
		]) {
			expect(readme).toContain(expected);
		}

		for (const obsolete of [
			"authStatePath",
			"SHOPIFY_E2E_AUTH_STATE_PATH",
			"--auth-state",
			"auth restore",
			"shared page",
			"shared Chrome tab/page",
			"shopify.admin.prepare",
		]) {
			expect(readme).not.toContain(obsolete);
		}

		expect(readme).not.toContain("FILEBEAN_E2E");
	});
});
