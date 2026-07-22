import type {
	Fixtures,
	PlaywrightTestArgs,
	PlaywrightWorkerArgs,
} from "@playwright/test";

import { openStorefront, unlockStorefront } from "./storefront.cjs";

export interface StorefrontFixture {
	open(): Promise<void>;
	unlock(): Promise<void>;
}

export interface ShopifyFixtures {
	readonly storefront: StorefrontFixture;
}

export const shopifyFixtures: Fixtures<
	ShopifyFixtures,
	Record<never, never>,
	PlaywrightTestArgs,
	PlaywrightWorkerArgs
> = {
	storefront: async ({ page }, use) => {
		await use({
			open: () => openStorefront(page),
			unlock: () => unlockStorefront(page),
		});
	},
};
