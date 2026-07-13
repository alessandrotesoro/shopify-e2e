import { expect, test } from "@playwright/test";

test("consumer dotenv reaches Playwright", () => {
	expect(process.env.SHOPIFY_E2E_DOTENV_SENTINEL).toBe(
		process.env.SHOPIFY_E2E_DOTENV_EXPECTED,
	);
});
