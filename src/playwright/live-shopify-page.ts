import type { Page } from "playwright-core";

import {
	type ResolveConfigOptions,
	type ResolvedShopifyE2EConfig,
	resolveShopifyE2EConfig,
} from "../shopify-e2e-config.js";
import {
	createLiveShopifyPage as createSessionPage,
	gotoLiveShopifyPage as gotoSessionPage,
	type LiveShopifyPage,
	openLiveShopifyPage as openSessionPage,
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
	if (isResolvedShopifyE2EConfig(config)) {
		return config;
	}

	return resolveShopifyE2EConfig(config);
}

function isResolvedShopifyE2EConfig(
	config: ResolvedShopifyE2EConfig | ResolveConfigOptions | undefined,
): config is ResolvedShopifyE2EConfig {
	return (
		Boolean(config) &&
		typeof config?.authStatePath === "string" &&
		typeof config.cdpPort === "string" &&
		typeof config.cdpUrl === "string" &&
		typeof config.chromeProfilePath === "string" &&
		typeof config.cwd === "string" &&
		typeof config.live === "boolean" &&
		Array.isArray(config.testFiles) &&
		isResolvedTestCommand(config.testCommand)
	);
}

function isResolvedTestCommand(
	value: unknown,
): value is ResolvedShopifyE2EConfig["testCommand"] {
	if (!isRecord(value)) {
		return false;
	}

	return (
		typeof value.command === "string" &&
		Array.isArray(value.args) &&
		typeof value.mode === "string" &&
		typeof value.shell === "boolean"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
