import { defineShopifyE2EConfig } from "@sematico/shopify-e2e/config";

export default defineShopifyE2EConfig({
	testDir: "shopify-smoke",
	roles: ["guest", "storefront-access"],
	use: {
		trace: "off",
	},
});
