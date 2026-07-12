import { createJiti } from "jiti";

import { ShopifyE2EPreflightError } from "../errors.js";
import { discoverShopifySpecs } from "./discover-specs.js";
import {
	resolveProjectRoot,
	resolveShopifyConfigPath,
	resolveShopifyTestDir,
} from "./project-boundary.js";
import type {
	LoadedShopifyConfig,
	LoadShopifyConfigOptions,
	ShopifyE2EConfig,
} from "./types.js";

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}

function validateConfigExport(
	value: unknown,
	configPath: string,
): ShopifyE2EConfig {
	if (!isRecord(value)) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config must default-export an object: ${configPath}`,
			{ configPath },
		);
	}

	const keys = Reflect.ownKeys(value);
	if (keys.length !== 1 || keys[0] !== "testDir") {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config must contain exactly one key, testDir: ${configPath}`,
			{ configPath },
		);
	}

	const testDir = value.testDir;
	if (typeof testDir !== "string" || testDir.trim().length === 0) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config testDir must be a non-empty string: ${configPath}`,
			{ configPath },
		);
	}
	return { testDir };
}

function withConfigContext(
	error: unknown,
	configPath: string,
): ShopifyE2EPreflightError {
	if (error instanceof ShopifyE2EPreflightError && error.configPath)
		return error;
	if (error instanceof ShopifyE2EPreflightError) {
		return new ShopifyE2EPreflightError(error.message, {
			cause: error,
			configPath,
		});
	}
	return new ShopifyE2EPreflightError(
		`Dedicated Shopify config could not load: ${configPath}`,
		{ cause: error, configPath },
	);
}

export async function loadShopifyConfig(
	options: LoadShopifyConfigOptions,
): Promise<LoadedShopifyConfig> {
	const projectRoot = await resolveProjectRoot(options.cwd);
	const configPath = await resolveShopifyConfigPath(
		projectRoot,
		options.configPath,
	);

	try {
		const jiti = createJiti(import.meta.url, {
			fsCache: false,
			interopDefault: false,
			moduleCache: false,
		});
		const moduleNamespace =
			await jiti.import<Record<PropertyKey, unknown>>(configPath);
		if (!Object.hasOwn(moduleNamespace, "default")) {
			throw new ShopifyE2EPreflightError(
				`Dedicated Shopify config must have a default export: ${configPath}`,
				{ configPath },
			);
		}

		const config = validateConfigExport(moduleNamespace.default, configPath);
		const testDir = await resolveShopifyTestDir(projectRoot, config.testDir);
		const specFiles = await discoverShopifySpecs(testDir);
		return { configPath, projectRoot, specFiles, testDir };
	} catch (error) {
		throw withConfigContext(error, configPath);
	}
}
