import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { defaultCdpPort, defaultConfig } from "./config/defaults.js";
import { configFromEnv, parseEnvFile } from "./config/env.js";
import { findConfigFile, loadConfigFile } from "./config/file.js";
import { mergeConfig } from "./config/merge.js";
import {
	normalizeOptionalCommand,
	normalizeStringArray,
	normalizeTestCommand,
} from "./config/normalize.js";
import {
	cdpPortFromUrl,
	cleanString,
	resolvePath,
} from "./config/primitives.js";

export { parseEnvFile } from "./config/env.js";

export type CommandMode = "playwright" | "custom" | "shell";

export interface CommandObject {
	args?: string[];
	command?: string;
	mode?: CommandMode;
	shell?: boolean;
}

export type CommandInput = string | CommandObject;

export type TestCommandMode = CommandMode;
export type TestCommandObject = CommandObject;
export type TestCommandInput = string | TestCommandObject;

export interface ShopifyE2EConfig {
	appUrl?: string;
	appSetupCommand?: CommandInput;
	authStatePath?: string;
	cdpPort?: number | string;
	cdpUrl?: string;
	chromeExecutablePath?: string;
	chromeProfilePath?: string;
	envFile?: string;
	live?: boolean;
	shopDomain?: string;
	storefrontDomain?: string;
	storefrontPassword?: string;
	testCommand?: TestCommandInput;
	testFiles?: string[];
}

export interface ResolveConfigOptions extends ShopifyE2EConfig {
	configPath?: string;
	cwd?: string;
}

export interface ResolvedTestCommand {
	args: string[];
	command: string;
	mode: CommandMode;
	shell: boolean;
}

export type ResolvedCommand = ResolvedTestCommand;

export interface ResolvedShopifyE2EConfig {
	appUrl?: string;
	appSetupCommand?: ResolvedCommand;
	authStatePath: string;
	cdpPort: string;
	cdpUrl: string;
	chromeExecutablePath?: string;
	chromeProfilePath: string;
	configPath?: string;
	cwd: string;
	envFile?: string;
	live: boolean;
	shopDomain?: string;
	storefrontDomain?: string;
	storefrontPassword?: string;
	testCommand: ResolvedTestCommand;
	testFiles: string[];
}

export function defineShopifyE2EConfig<T extends ShopifyE2EConfig>(
	config: T,
): T {
	return config;
}

export async function resolveShopifyE2EConfig(
	options: ResolveConfigOptions = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedShopifyE2EConfig> {
	const cwd = options.cwd ?? process.cwd();
	const optionConfigPath = cleanString(options.configPath);
	const configPath = optionConfigPath
		? resolvePath(cwd, optionConfigPath)
		: await findConfigFile(cwd);
	const fileConfig = await loadConfigFile(configPath);
	const envFile = cleanString(
		options.envFile ?? env.SHOPIFY_E2E_ENV_FILE ?? fileConfig.envFile,
	);
	const mergedEnv = envFile
		? { ...parseEnvFile(resolvePath(cwd, envFile)), ...env }
		: env;
	const envConfig = configFromEnv(mergedEnv);
	const merged = mergeConfig(
		defaultConfig(cwd),
		fileConfig,
		envConfig,
		options,
	);
	const configuredCdpUrl = cleanString(merged.cdpUrl);
	const configuredCdpPort = cleanString(
		merged.cdpPort === undefined ? undefined : String(merged.cdpPort),
	);
	const cdpPort =
		configuredCdpPort ?? cdpPortFromUrl(configuredCdpUrl) ?? defaultCdpPort;
	const cdpUrl = configuredCdpUrl ?? `http://127.0.0.1:${cdpPort}`;

	return {
		appUrl: cleanString(merged.appUrl),
		appSetupCommand: normalizeOptionalCommand(merged.appSetupCommand),
		authStatePath: resolvePath(
			cwd,
			cleanString(merged.authStatePath) ??
				".shopify-e2e/auth/shopify-storage-state.json",
		),
		cdpPort,
		cdpUrl,
		chromeExecutablePath: cleanString(merged.chromeExecutablePath),
		chromeProfilePath: resolvePath(
			cwd,
			cleanString(merged.chromeProfilePath) ??
				".shopify-e2e/chrome-profile",
		),
		configPath,
		cwd,
		envFile: envFile ? resolvePath(cwd, envFile) : undefined,
		live: Boolean(merged.live),
		shopDomain: cleanString(merged.shopDomain),
		storefrontDomain: cleanString(merged.storefrontDomain),
		storefrontPassword: cleanString(merged.storefrontPassword),
		testCommand: normalizeTestCommand(merged.testCommand),
		testFiles: normalizeStringArray(merged.testFiles),
	};
}

export async function ensureParentDirectory(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
}

export function missingLiveShopifyPrerequisites(
	config: Pick<ResolvedShopifyE2EConfig, "appUrl" | "cdpUrl" | "shopDomain">,
	options: { requireAppUrl?: boolean } = {},
): string[] {
	const missing: string[] = [];

	if (!config.cdpUrl) {
		missing.push("SHOPIFY_E2E_CDP_URL or SHOPIFY_E2E_CDP_PORT");
	}

	if (!config.shopDomain) {
		missing.push("SHOPIFY_E2E_SHOP_DOMAIN");
	}

	if (options.requireAppUrl !== false && !config.appUrl) {
		missing.push("SHOPIFY_E2E_APP_URL");
	}

	return missing;
}

export function hasLiveShopifyPrerequisites(
	config: Pick<ResolvedShopifyE2EConfig, "appUrl" | "cdpUrl" | "shopDomain">,
	options: { requireAppUrl?: boolean } = {},
): boolean {
	return missingLiveShopifyPrerequisites(config, options).length === 0;
}

export function liveShopifySkipReason(
	config: Pick<ResolvedShopifyE2EConfig, "appUrl" | "cdpUrl" | "shopDomain">,
	options: { requireAppUrl?: boolean } = {},
): string {
	const missing = missingLiveShopifyPrerequisites(config, options);

	return missing.length === 0
		? "Live Shopify e2e prerequisites are configured."
		: `Live Shopify e2e skipped. Missing: ${missing.join(", ")}.`;
}
