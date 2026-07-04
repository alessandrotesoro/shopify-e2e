import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { isRecord } from "../guards.js";
import type {
	ShopifyE2EConfig,
	TestCommandInput,
	TestCommandMode,
	TestCommandObject,
} from "../shopify-e2e-config.js";
import { defaultConfigFiles, testCommandModes } from "./defaults.js";
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
