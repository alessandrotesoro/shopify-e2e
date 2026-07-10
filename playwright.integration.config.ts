import { defineConfig } from "@playwright/test";

export default defineConfig({
	fullyParallel: false,
	outputDir: "test-results/browser-isolation",
	retries: 0,
	testDir: "./tests/browser",
	use: {
		headless: true,
		screenshot: "off",
		trace: "off",
		video: "off",
	},
	workers: 1,
});
