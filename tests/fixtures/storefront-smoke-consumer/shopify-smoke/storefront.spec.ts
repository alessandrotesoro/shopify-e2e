import { test as base, expect } from "@playwright/test";
import {
	type ShopifyFixtures,
	shopifyFixtures,
} from "@sematico/shopify-e2e/playwright";

const test = base.extend<ShopifyFixtures>(shopifyFixtures);

const passwordChallenge = 'form:has(input[type="password"])';

const roleCases = [
	{
		name: "guest explicitly unlocks the password-protected storefront",
		role: "guest",
	},
	{
		name: "saved storefront access remains stable when unlock is already satisfied",
		role: "storefront-access",
	},
] as const;

for (const { name, role } of roleCases) {
	test(name, { tag: `@shopify-e2e-role-${role}` }, async ({
		page,
		storefront,
	}) => {
		await storefront.open();
		await storefront.unlock();
		const unlockedUrl = page.url();
		await storefront.unlock();

		expect(page.url()).toBe(unlockedUrl);
		await expect(page.locator(passwordChallenge)).toHaveCount(0);
		await expect(page.locator("body")).toBeVisible();
	});
}
