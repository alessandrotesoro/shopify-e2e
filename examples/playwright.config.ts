import { defineConfig } from "@playwright/test";
import { globalSetupPath } from "shopify-e2e";

export default defineConfig({
	globalSetup: globalSetupPath,
	workers: 1,
	use: {
		trace: "retain-on-failure",
	},
});
