import { test as base, expect, type Page } from "@playwright/test";
import {
	type ShopifyFixtures,
	shopifyFixtures,
} from "@sematico/shopify-e2e/playwright";

const test = base.extend<ShopifyFixtures>(shopifyFixtures);

const storeOrigin = "https://levelogy-development.myshopify.com";
const passwordChallenge = 'form:has(input[type="password"])';
const storefrontMain = "main#MainContent";

const expectHealthyLevelogyStorefront = async (page: Page): Promise<void> => {
	const currentUrl = new URL(page.url());
	expect(currentUrl.origin).toBe(storeOrigin);
	expect(currentUrl.pathname).toBe("/");
	await expect(page.locator(storefrontMain)).toBeVisible();
};

const roles = ["guest", "storefront-access"] as const;

for (const role of roles) {
	test(`${role} explicitly unlocks the password-protected storefront`, {
		tag: `@shopify-e2e-role-${role}`,
	}, async ({ page, storefront }) => {
		await page.context().clearCookies({
			domain: /levelogy-development\.myshopify\.com$/,
		});
		await storefront.open();
		await expect(page.locator(passwordChallenge)).toBeVisible();

		await storefront.unlock();
		await expect(page.locator(passwordChallenge)).toHaveCount(0);
		await expectHealthyLevelogyStorefront(page);
		const unlockedUrl = page.url();

		await storefront.unlock();

		expect(page.url()).toBe(unlockedUrl);
		await expect(page.locator(passwordChallenge)).toHaveCount(0);
		await expectHealthyLevelogyStorefront(page);
	});
}
