const { defineShopifyE2EConfig } =
	require("@sematico/shopify-e2e/config") as typeof import("../../../src/config/public.cjs");

export default defineShopifyE2EConfig({
	roles: ["admin", "customer"],
	testDir: "shopify-tests",
});
