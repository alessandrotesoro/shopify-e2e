import { createJiti } from "jiti";

import { ShopifyE2EPreflightError } from "../errors.js";
import { discoverShopifySpecs } from "./discover-specs.js";
import {
	resolveProjectRoot,
	resolveShopifyConfigPath,
	resolveShopifyTestDir,
} from "./project-boundary.js";

export interface ShopifyE2EConfig {
	readonly testDir: string;
}

export interface LoadShopifyConfigOptions {
	readonly configPath?: string;
	readonly cwd: string;
}

export interface LoadedShopifyConfig {
	readonly configPath: string;
	readonly projectRoot: string;
	readonly testDir: string;
}

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
};

interface ValidateConfigExportArgs {
	readonly configPath: string;
	readonly value: unknown;
}

const validateConfigExport = ({
	configPath,
	value,
}: ValidateConfigExportArgs): ShopifyE2EConfig => {
	if (!isRecord(value)) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config must default-export an object: ${configPath}`,
		);
	}

	const keys = Reflect.ownKeys(value);
	if (keys.length !== 1 || keys[0] !== "testDir") {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config must contain exactly one key, testDir: ${configPath}`,
		);
	}

	const testDir = value.testDir;
	if (typeof testDir !== "string" || testDir.trim().length === 0) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config testDir must be a non-empty string: ${configPath}`,
		);
	}
	return { testDir };
};

interface WithConfigContextArgs {
	readonly configPath: string;
	readonly error: unknown;
}

const withConfigContext = ({
	configPath,
	error,
}: WithConfigContextArgs): ShopifyE2EPreflightError => {
	if (error instanceof ShopifyE2EPreflightError) return error;
	return new ShopifyE2EPreflightError(
		`Dedicated Shopify config could not load: ${configPath}`,
		{ cause: error },
	);
};

export const loadShopifyConfig = async (
	options: LoadShopifyConfigOptions,
): Promise<LoadedShopifyConfig> => {
	const projectRoot = await resolveProjectRoot(options.cwd);
	const configPath = await resolveShopifyConfigPath({
		explicitConfigPath: options.configPath,
		projectRoot,
	});

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
			);
		}

		const config = validateConfigExport({
			configPath,
			value: moduleNamespace.default,
		});
		const testDir = await resolveShopifyTestDir({
			configuredTestDir: config.testDir,
			projectRoot,
		});
		await discoverShopifySpecs(testDir);
		return { configPath, projectRoot, testDir };
	} catch (error) {
		throw withConfigContext({ configPath, error });
	}
};
