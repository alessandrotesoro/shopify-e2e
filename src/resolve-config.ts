import { isRecord } from "./guards.js";
import {
	type ResolveConfigOptions,
	type ResolvedShopifyE2EConfig,
	resolveShopifyE2EConfig,
} from "./shopify-e2e-config.js";

export type ShopifyE2EConfigInput =
	| ResolveConfigOptions
	| ResolvedShopifyE2EConfig;

export async function resolveConfigInput(
	config: ShopifyE2EConfigInput | undefined,
): Promise<ResolvedShopifyE2EConfig> {
	if (isResolvedShopifyE2EConfig(config)) {
		return config;
	}

	return resolveShopifyE2EConfig(config);
}

function isResolvedShopifyE2EConfig(
	config: ShopifyE2EConfigInput | undefined,
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
