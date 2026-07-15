import { defineShopifyE2EConfig } from "@sematico/shopify-e2e/config";

export default defineShopifyE2EConfig({
	testDir: "shopify-passing",
	roles: ["admin", "customer", "guest"],
});
