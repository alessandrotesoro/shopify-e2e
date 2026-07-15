import { expect, type Page, test } from "@playwright/test";

const configuredStoreOrigin = (): string => {
	const configuredStoreUrl = process.env.SHOPIFY_STORE_URL;
	if (!configuredStoreUrl) throw new Error("SHOPIFY_STORE_URL is required");
	const url = new URL(configuredStoreUrl);
	if (url.protocol !== "https:") {
		throw new Error("SHOPIFY_STORE_URL must be an absolute HTTPS URL");
	}
	return url.origin;
};

const passwordChallenge = (page: Page) =>
	page.locator(
		'form[action="/password"] input[type="password"], input#Password',
	);

test("saved storefront access role bypasses the storefront password challenge", {
	tag: "@shopify-e2e-role-storefront-access",
}, async ({ page }) => {
	const response = await page.goto(configuredStoreOrigin(), {
		waitUntil: "domcontentloaded",
	});
	expect(response).not.toBeNull();
	expect(response?.ok()).toBe(true);
	await expect(passwordChallenge(page)).toHaveCount(0);
	await expect(page.locator("body")).toBeVisible();
});

test("guest role reaches the storefront password challenge", {
	tag: "@shopify-e2e-role-guest",
}, async ({ page }) => {
	const response = await page.goto(configuredStoreOrigin(), {
		waitUntil: "domcontentloaded",
	});
	expect(response).not.toBeNull();
	expect(response?.ok()).toBe(true);
	await expect(passwordChallenge(page).first()).toBeVisible();
});
