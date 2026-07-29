import { test as base, expect as playwrightExpect } from "@playwright/test";

import {
	type ShopifyFixtures,
	type StorefrontFixture,
	shopifyFixtures,
	type TypeLikeHumanOptions,
	typeLikeHuman,
	unlockStorefront,
} from "@sematico/shopify-e2e/playwright";

const directTest = base.extend<ShopifyFixtures>(shopifyFixtures);

const consumerTest = base.extend<{ consumerValue: string }>({
	consumerValue: async (_fixtures, use) => {
		await use("consumer-owned");
	},
});
const composedTest = consumerTest.extend<ShopifyFixtures>(shopifyFixtures);

directTest("direct fixture composition", async ({ storefront }) => {
	await storefront.open();
	await storefront.unlock();
});

composedTest(
	"ordinary consumer fixture composition",
	async ({ consumerValue, page, storefront }) => {
		playwrightExpect(consumerValue).toBe("consumer-owned");
		await storefront.open();
		await storefront.unlock();
		await unlockStorefront(page);
		await typeLikeHuman(page.locator("input"), "value", {
			delay: 1,
		} satisfies TypeLikeHumanOptions);
	},
);

const storefrontContract = async (storefront: StorefrontFixture) => {
	await storefront.open();
	await storefront.unlock();
};

void storefrontContract;
