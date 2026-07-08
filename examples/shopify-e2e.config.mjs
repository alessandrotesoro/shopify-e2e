import { defineShopifyE2EConfig } from "shopify-e2e";

export default defineShopifyE2EConfig({
	shopDomain: "example.myshopify.com",
	appUrl: "https://example-app.ngrok.app",
	cdpPort: 9222,
	chromeProfilePath: ".shopify-e2e/chrome-profile",
	authStatePath: ".shopify-e2e/auth/shopify-storage-state.json",
	storefrontPassword: process.env.SHOPIFY_E2E_STOREFRONT_PASSWORD,
	appSetupCommand: {
		command: "npm",
		args: ["run", "e2e:shopify:prepare"],
		mode: "custom",
	},
	testFiles: ["e2e"],
	testCommand: {
		command: process.platform === "win32" ? "npx.cmd" : "npx",
		args: ["playwright", "test"],
		mode: "playwright",
	},
});
