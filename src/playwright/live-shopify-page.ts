import type { Page } from "playwright-core";

import {
	type ResolveConfigOptions,
	type ResolvedShopifyE2EConfig,
	resolveShopifyE2EConfig,
} from "../config.js";
import {
	createLiveShopifyPage as createSessionPage,
	gotoLiveShopifyPage as gotoSessionPage,
	openLiveShopifyPage as openSessionPage,
	type LiveShopifyPage,
} from "../shopify-session.js";

export type { LiveShopifyPage };

export async function createLiveShopifyPage(
	config?: ResolvedShopifyE2EConfig | ResolveConfigOptions,
): Promise<LiveShopifyPage> {
	return createSessionPage(await resolveMaybeConfig(config));
}

export async function openLiveShopifyPage(
	url: string,
	config?: ResolvedShopifyE2EConfig | ResolveConfigOptions,
): Promise<LiveShopifyPage> {
	return openSessionPage(await resolveMaybeConfig(config), url);
}

export async function gotoLiveShopifyPage(
	page: Page,
	url: string,
): Promise<void> {
	await gotoSessionPage(page, url);
}

async function resolveMaybeConfig(
	config: ResolvedShopifyE2EConfig | ResolveConfigOptions | undefined,
): Promise<ResolvedShopifyE2EConfig> {
	if (config && "cdpUrl" in config && "authStatePath" in config) {
		return config as ResolvedShopifyE2EConfig;
	}

	return resolveShopifyE2EConfig(config);
}
