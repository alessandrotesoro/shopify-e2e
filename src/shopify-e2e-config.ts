import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type TestCommandMode = "playwright" | "custom" | "shell";

export interface TestCommandObject {
	args?: string[];
	command?: string;
	mode?: TestCommandMode;
	shell?: boolean;
}

export type TestCommandInput = string | TestCommandObject;

export interface ShopifyE2EConfig {
	appUrl?: string;
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
	mode: TestCommandMode;
	shell: boolean;
}

export interface ResolvedShopifyE2EConfig {
	appUrl?: string;
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

const defaultConfigFiles = [
	"shopify-e2e.config.mjs",
	"shopify-e2e.config.js",
	"shopify-e2e.config.cjs",
	"shopify-e2e.config.json",
] as const;

const defaultCdpPort = "9222";
const testCommandModes = ["playwright", "custom", "shell"] as const;

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

export function parseEnvFile(path: string): NodeJS.ProcessEnv {
	if (!existsSync(path)) {
		return {};
	}

	const entries: NodeJS.ProcessEnv = {};
	const contents = readFileSync(path, "utf8");

	for (const line of contents.split(/\r?\n/)) {
		const parsed = parseEnvLine(line);

		if (parsed) {
			entries[parsed.key] = parsed.value;
		}
	}

	return entries;
}

async function loadConfigFile(
	configPath: string | undefined,
): Promise<ShopifyE2EConfig> {
	if (!configPath) {
		return {};
	}

	if (configPath.endsWith(".json")) {
		return parseConfigFileInput({
			configPath,
			input: parseConfigJson({
				configPath,
				contents: await readFile(configPath, "utf8"),
			}),
		});
	}

	try {
		const imported = (await import(
			`${pathToFileURL(configPath).toString()}?t=${Date.now()}`
		)) as {
			default?: unknown;
			config?: unknown;
		};

		return parseConfigFileInput({
			configPath,
			input: imported.default ?? imported.config ?? {},
		});
	} catch (error) {
		throw new Error(
			`Could not load Shopify E2E config from ${configPath}.`,
			{
				cause: error,
			},
		);
	}
}

async function findConfigFile(cwd: string): Promise<string | undefined> {
	for (const file of defaultConfigFiles) {
		const path = resolve(cwd, file);

		if (existsSync(path)) {
			return path;
		}
	}

	return undefined;
}

function defaultConfig(cwd: string): ShopifyE2EConfig {
	return {
		authStatePath: resolve(
			cwd,
			".shopify-e2e/auth/shopify-storage-state.json",
		),
		chromeProfilePath: resolve(cwd, ".shopify-e2e/chrome-profile"),
		live: false,
		testCommand: {
			args: ["playwright", "test"],
			command: process.platform === "win32" ? "npx.cmd" : "npx",
			mode: "playwright",
		},
		testFiles: [],
	};
}

interface ParseConfigJsonArgs {
	configPath: string;
	contents: string;
}

function parseConfigJson({
	configPath,
	contents,
}: ParseConfigJsonArgs): unknown {
	try {
		return JSON.parse(contents) as unknown;
	} catch (error) {
		throw new Error(
			`Could not parse Shopify E2E config from ${configPath}.`,
			{
				cause: error,
			},
		);
	}
}

interface ParseConfigFileInputArgs {
	configPath: string;
	input: unknown;
}

function parseConfigFileInput({
	configPath,
	input,
}: ParseConfigFileInputArgs): ShopifyE2EConfig {
	if (input === null || input === undefined) {
		return {};
	}

	if (!isRecord(input)) {
		throw invalidConfigField(configPath, "root", "expected an object");
	}

	return {
		appUrl: optionalStringField(input, "appUrl", configPath),
		authStatePath: optionalStringField(input, "authStatePath", configPath),
		cdpPort: optionalStringOrNumberField(input, "cdpPort", configPath),
		cdpUrl: optionalStringField(input, "cdpUrl", configPath),
		chromeExecutablePath: optionalStringField(
			input,
			"chromeExecutablePath",
			configPath,
		),
		chromeProfilePath: optionalStringField(
			input,
			"chromeProfilePath",
			configPath,
		),
		envFile: optionalStringField(input, "envFile", configPath),
		live: optionalBooleanField(input, "live", configPath),
		shopDomain: optionalStringField(input, "shopDomain", configPath),
		storefrontDomain: optionalStringField(
			input,
			"storefrontDomain",
			configPath,
		),
		storefrontPassword: optionalStringField(
			input,
			"storefrontPassword",
			configPath,
		),
		testCommand: optionalTestCommandField(input, "testCommand", configPath),
		testFiles: optionalStringArrayField(input, "testFiles", configPath),
	};
}

function optionalStringField(
	config: Record<string, unknown>,
	field: string,
	configPath: string,
): string | undefined {
	const value = config[field];

	if (value === undefined || value === null) {
		return undefined;
	}

	if (typeof value === "string") {
		return value;
	}

	throw invalidConfigField(configPath, field, "expected a string");
}

function optionalStringOrNumberField(
	config: Record<string, unknown>,
	field: string,
	configPath: string,
): string | number | undefined {
	const value = config[field];

	if (value === undefined || value === null) {
		return undefined;
	}

	if (typeof value === "string" || typeof value === "number") {
		return value;
	}

	throw invalidConfigField(configPath, field, "expected a string or number");
}

function optionalBooleanField(
	config: Record<string, unknown>,
	field: string,
	configPath: string,
): boolean | undefined {
	const value = config[field];

	if (value === undefined || value === null) {
		return undefined;
	}

	if (typeof value === "boolean") {
		return value;
	}

	if (typeof value === "string") {
		return parseConfigBoolean(value, configPath, field);
	}

	throw invalidConfigField(configPath, field, "expected a boolean");
}

function parseConfigBoolean(
	value: string,
	configPath: string,
	field: string,
): boolean {
	const cleaned = cleanString(value)?.toLowerCase();

	if (!cleaned) {
		throw invalidConfigField(configPath, field, "expected a boolean");
	}

	if (["1", "true", "yes", "on"].includes(cleaned)) {
		return true;
	}

	if (["0", "false", "no", "off"].includes(cleaned)) {
		return false;
	}

	throw invalidConfigField(configPath, field, "expected a boolean");
}

function optionalStringArrayField(
	config: Record<string, unknown>,
	field: string,
	configPath: string,
): string[] | undefined {
	const value = config[field];

	if (value === undefined || value === null) {
		return undefined;
	}

	if (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === "string")
	) {
		return value;
	}

	throw invalidConfigField(configPath, field, "expected an array of strings");
}

function optionalTestCommandField(
	config: Record<string, unknown>,
	field: string,
	configPath: string,
): TestCommandInput | undefined {
	const value = config[field];

	if (value === undefined || value === null) {
		return undefined;
	}

	if (typeof value === "string") {
		return value;
	}

	if (!isRecord(value)) {
		throw invalidConfigField(
			configPath,
			field,
			"expected a string or object",
		);
	}

	return {
		args: optionalStringArrayField(value, "args", configPath),
		command: optionalStringField(value, "command", configPath),
		mode: optionalTestCommandModeField(value, "mode", configPath),
		shell: optionalBooleanField(value, "shell", configPath),
	};
}

function optionalTestCommandModeField(
	config: Record<string, unknown>,
	field: keyof TestCommandObject,
	configPath: string,
): TestCommandMode | undefined {
	const value = config[field];

	if (value === undefined || value === null) {
		return undefined;
	}

	if (
		typeof value === "string" &&
		testCommandModes.includes(value as TestCommandMode)
	) {
		return value as TestCommandMode;
	}

	throw invalidConfigField(
		configPath,
		`testCommand.${field}`,
		`expected one of: ${testCommandModes.join(", ")}`,
	);
}

function invalidConfigField(
	configPath: string,
	field: string | number | symbol,
	reason: string,
): Error {
	return new Error(
		`Invalid Shopify E2E config at ${configPath}: ${String(field)} ${reason}.`,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function configFromEnv(env: NodeJS.ProcessEnv): ShopifyE2EConfig {
	return {
		appUrl: cleanString(env.SHOPIFY_E2E_APP_URL),
		authStatePath: cleanString(env.SHOPIFY_E2E_AUTH_STATE_PATH),
		cdpPort: cleanString(env.SHOPIFY_E2E_CDP_PORT),
		cdpUrl: cleanString(env.SHOPIFY_E2E_CDP_URL),
		chromeExecutablePath: cleanString(env.SHOPIFY_E2E_CHROME_PATH),
		chromeProfilePath: cleanString(env.SHOPIFY_E2E_CHROME_PROFILE_PATH),
		envFile: cleanString(env.SHOPIFY_E2E_ENV_FILE),
		live: parseBoolean(env.SHOPIFY_E2E_LIVE),
		shopDomain: cleanString(env.SHOPIFY_E2E_SHOP_DOMAIN),
		storefrontDomain: cleanString(env.SHOPIFY_E2E_STOREFRONT_DOMAIN),
		storefrontPassword: cleanString(env.SHOPIFY_E2E_STOREFRONT_PASSWORD),
		testCommand: cleanString(env.SHOPIFY_E2E_TEST_COMMAND),
		testFiles: splitList(env.SHOPIFY_E2E_TEST_FILES),
	};
}

function mergeConfig(
	...configs: Array<ShopifyE2EConfig | undefined>
): ShopifyE2EConfig {
	const merged: ShopifyE2EConfig = {};

	for (const config of configs) {
		if (!config) {
			continue;
		}

		for (const [key, value] of Object.entries(config) as Array<
			[keyof ShopifyE2EConfig, ShopifyE2EConfig[keyof ShopifyE2EConfig]]
		>) {
			if (value === undefined || value === "") {
				continue;
			}

			merged[key] = value as never;
		}
	}

	return merged;
}

function normalizeTestCommand(
	input: TestCommandInput | undefined,
): ResolvedTestCommand {
	if (typeof input === "string") {
		return {
			args: [],
			command: input,
			mode: "shell",
			shell: true,
		};
	}

	return {
		args: normalizeStringArray(input?.args),
		command:
			cleanString(input?.command) ??
			(process.platform === "win32" ? "npx.cmd" : "npx"),
		mode: input?.mode ?? "playwright",
		shell: input?.shell ?? input?.mode === "shell",
	};
}

function normalizeStringArray(value: string[] | undefined): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.map((entry) => entry.trim()).filter(Boolean);
}

function parseEnvLine(line: string): { key: string; value: string } | null {
	const trimmed = line.trim();

	if (!trimmed || trimmed.startsWith("#")) {
		return null;
	}

	const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
		trimmed,
	);

	if (!match) {
		return null;
	}

	return {
		key: match[1] as string,
		value: parseEnvValue(match[2] as string),
	};
}

function parseEnvValue(value: string): string {
	const trimmed = value.trim();
	const quote = trimmed[0];

	if (
		(quote === '"' || quote === "'") &&
		trimmed.endsWith(quote) &&
		trimmed.length >= 2
	) {
		const unquoted = trimmed.slice(1, -1);

		return quote === '"' ? unescapeDoubleQuotedValue(unquoted) : unquoted;
	}

	return stripInlineComment(trimmed);
}

function stripInlineComment(value: string): string {
	const index = value.search(/\s#/);

	return index === -1 ? value : value.slice(0, index).trimEnd();
}

function unescapeDoubleQuotedValue(value: string): string {
	return value
		.replaceAll("\\n", "\n")
		.replaceAll('\\"', '"')
		.replaceAll("\\\\", "\\");
}

function cleanString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();

	return trimmed ? trimmed : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
	const cleaned = cleanString(value)?.toLowerCase();

	if (!cleaned) {
		return undefined;
	}

	return ["1", "true", "yes", "on"].includes(cleaned);
}

function splitList(value: string | undefined): string[] | undefined {
	const cleaned = cleanString(value);

	if (!cleaned) {
		return undefined;
	}

	return cleaned
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function cdpPortFromUrl(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	try {
		const url = new URL(value);

		return cleanString(url.port);
	} catch {
		return undefined;
	}
}

function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}
