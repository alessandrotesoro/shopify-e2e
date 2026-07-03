import { defineConfig } from "@playwright/test";
import { globalSetup } from "shopify-e2e";

export default defineConfig({
	globalSetup,
	workers: 1,
	use: {
		trace: "retain-on-failure",
	},
});
