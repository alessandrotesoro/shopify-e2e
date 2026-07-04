import type { Page } from "playwright-core";
import type { ShopifyE2EConfigInput } from "../resolve-config.js";
import { resolveConfigInput } from "../resolve-config.js";
import {
	createLiveShopifyPage as createSessionPage,
	gotoLiveShopifyPage as gotoSessionPage,
	type LiveShopifyPage,
	openLiveShopifyPage as openSessionPage,
} from "../shopify-session.js";

export type { LiveShopifyPage };

export async function createLiveShopifyPage(
	config?: ShopifyE2EConfigInput,
): Promise<LiveShopifyPage> {
	return createSessionPage(await resolveConfigInput(config));
}

export async function openLiveShopifyPage(
	url: string,
	config?: ShopifyE2EConfigInput,
): Promise<LiveShopifyPage> {
	return openSessionPage(await resolveConfigInput(config), url);
}

export async function gotoLiveShopifyPage(
	page: Page,
	url: string,
): Promise<void> {
	await gotoSessionPage(page, url);
}
