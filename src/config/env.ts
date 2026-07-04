import { existsSync, readFileSync } from "node:fs";

import type { ShopifyE2EConfig } from "../shopify-e2e-config.js";
import { cleanString, parseBoolean, splitList } from "./primitives.js";

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

export function configFromEnv(env: NodeJS.ProcessEnv): ShopifyE2EConfig {
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
