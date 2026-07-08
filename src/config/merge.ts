import type { ShopifyE2EConfig } from "../shopify-e2e-config.js";

export function mergeConfig(
	...configs: Array<ShopifyE2EConfig | undefined>
): ShopifyE2EConfig {
	const merged: ShopifyE2EConfig = {};

	for (const config of configs) {
		if (!config) {
			continue;
		}

		applyConfig(merged, config);
	}

	return merged;
}

function applyConfig(target: ShopifyE2EConfig, source: ShopifyE2EConfig): void {
	if (hasValue(source.appUrl)) {
		target.appUrl = source.appUrl;
	}

	if (hasValue(source.appSetupCommand)) {
		target.appSetupCommand = source.appSetupCommand;
	}

	if (hasValue(source.authStatePath)) {
		target.authStatePath = source.authStatePath;
	}

	if (hasValue(source.cdpPort)) {
		target.cdpPort = source.cdpPort;
	}

	if (hasValue(source.cdpUrl)) {
		target.cdpUrl = source.cdpUrl;
	}

	if (hasValue(source.chromeExecutablePath)) {
		target.chromeExecutablePath = source.chromeExecutablePath;
	}

	if (hasValue(source.chromeProfilePath)) {
		target.chromeProfilePath = source.chromeProfilePath;
	}

	if (hasValue(source.envFile)) {
		target.envFile = source.envFile;
	}

	if (source.live !== undefined) {
		target.live = source.live;
	}

	if (hasValue(source.shopDomain)) {
		target.shopDomain = source.shopDomain;
	}

	if (hasValue(source.storefrontDomain)) {
		target.storefrontDomain = source.storefrontDomain;
	}

	if (hasValue(source.storefrontPassword)) {
		target.storefrontPassword = source.storefrontPassword;
	}

	if (hasValue(source.testCommand)) {
		target.testCommand = source.testCommand;
	}

	if (source.testFiles !== undefined) {
		target.testFiles = source.testFiles;
	}
}

function hasValue<T>(value: T | "" | undefined): value is T {
	return value !== undefined && value !== "";
}
