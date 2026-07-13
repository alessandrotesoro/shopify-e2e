import { expect, test } from "@playwright/test";

test("consumer dotenv reaches Playwright", () => {
	expect(process.env.SHOPIFY_E2E_DOTENV_SENTINEL).toBe(
		process.env.SHOPIFY_E2E_DOTENV_EXPECTED,
	);
	expect(process.env.DOTENV_CONFIG_DEBUG).toBe(
		process.env.SHOPIFY_E2E_DOTENV_EXPECTED_DEBUG,
	);
	expect(process.env.DOTENV_CONFIG_QUIET).toBe(
		process.env.SHOPIFY_E2E_DOTENV_EXPECTED_QUIET,
	);
});
