import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { isRecord } from "../guards.js";
import type {
	CommandInput,
	CommandMode,
	CommandObject,
	ShopifyE2EConfig,
} from "../shopify-e2e-config.js";
import { commandModes, defaultConfigFiles } from "./defaults.js";
import { cleanString } from "./primitives.js";

export async function loadConfigFile(
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
			config?: unknown;
			default?: unknown;
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

export async function findConfigFile(cwd: string): Promise<string | undefined> {
	for (const file of defaultConfigFiles) {
		const path = resolve(cwd, file);

		if (existsSync(path)) {
			return path;
		}
	}

	return undefined;
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
		appSetupCommand: optionalCommandField(
			input,
			"appSetupCommand",
			configPath,
			{ requireCommand: true },
		),
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
		testCommand: optionalCommandField(input, "testCommand", configPath),
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

function optionalCommandField(
	config: Record<string, unknown>,
	field: string,
	configPath: string,
	options: { requireCommand?: boolean } = {},
): CommandInput | undefined {
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
		command: options.requireCommand
			? requiredStringField(
					value,
					"command",
					`${field}.command`,
					configPath,
				)
			: optionalStringField(value, "command", configPath),
		mode: optionalCommandModeField(value, field, "mode", configPath),
		shell: optionalBooleanField(value, "shell", configPath),
	};
}

function requiredStringField(
	config: Record<string, unknown>,
	field: string,
	errorField: string,
	configPath: string,
): string {
	const value = optionalStringField(config, field, configPath);

	if (value === undefined) {
		throw invalidConfigField(configPath, errorField, "expected a string");
	}

	return value;
}

function optionalCommandModeField(
	config: Record<string, unknown>,
	parentField: string,
	field: keyof CommandObject,
	configPath: string,
): CommandMode | undefined {
	const value = config[field];

	if (value === undefined || value === null) {
		return undefined;
	}

	if (
		typeof value === "string" &&
		commandModes.includes(value as CommandMode)
	) {
		return value as CommandMode;
	}

	throw invalidConfigField(
		configPath,
		`${parentField}.${field}`,
		`expected one of: ${commandModes.join(", ")}`,
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
