import { defineShopifyE2EConfig } from "../src/config/public.cjs";

defineShopifyE2EConfig({
	fullyParallel: true,
	reporter: "line",
	roles: ["admin", "customer"],
	testDir: "shopify-tests",
	use: { screenshot: "only-on-failure", trace: "retain-on-failure" },
});

defineShopifyE2EConfig({
	roles: ["admin"],
	testDir: "shopify-tests",
	// @ts-expect-error Shopify execution owns grep.
	grep: /checkout/,
});

defineShopifyE2EConfig({
	roles: ["admin"],
	testDir: "shopify-tests",
	// @ts-expect-error Shopify execution owns grepInvert.
	grepInvert: /draft/,
});

defineShopifyE2EConfig({
	roles: ["admin"],
	testDir: "shopify-tests",
	// @ts-expect-error Shopify execution owns workers.
	workers: 2,
});

defineShopifyE2EConfig({
	roles: ["admin"],
	testDir: "shopify-tests",
	use: {
		// @ts-expect-error Shopify execution owns storageState.
		storageState: "state.json",
	},
});

defineShopifyE2EConfig({
	roles: ["admin"],
	testDir: "shopify-tests",
	// @ts-expect-error Shopify execution does not support projects.
	projects: [],
});
