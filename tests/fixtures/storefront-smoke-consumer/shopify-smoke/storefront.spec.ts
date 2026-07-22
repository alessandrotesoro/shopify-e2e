import { test as base, expect } from "@playwright/test";
import {
	type ShopifyFixtures,
	shopifyFixtures,
} from "@sematico/shopify-e2e/playwright";

const test = base.extend<ShopifyFixtures>(shopifyFixtures);

const passwordChallenge = 'form:has(input[type="password"])';

test("saved storefront access remains stable when unlock is already satisfied", {
	tag: "@shopify-e2e-role-storefront-access",
}, async ({ page, storefront }) => {
	await storefront.open();
	await storefront.unlock();
	const unlockedUrl = page.url();
	await storefront.unlock();

	expect(page.url()).toBe(unlockedUrl);
	await expect(page.locator(passwordChallenge)).toHaveCount(0);
	await expect(page.locator("body")).toBeVisible();
});

test("guest explicitly unlocks the password-protected storefront", {
	tag: "@shopify-e2e-role-guest",
}, async ({ page, storefront }) => {
	await storefront.open();
	await storefront.unlock();
	const unlockedUrl = page.url();
	await storefront.unlock();

	expect(page.url()).toBe(unlockedUrl);
	await expect(page.locator(passwordChallenge)).toHaveCount(0);
	await expect(page.locator("body")).toBeVisible();
});
