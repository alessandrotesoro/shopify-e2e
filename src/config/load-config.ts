import { createJiti } from "jiti";

import { ShopifyE2EPreflightError } from "../errors.js";
import {
	type DefinedShopifyE2EConfig,
	isDefinedShopifyE2EConfig,
	isShopifyE2EConfigContractError,
} from "./define-config.cjs";
import { assertReservedExecutionEnvironmentIsClear } from "./execution-environment.cjs";
import {
	resolveShopifyConfigPath,
	resolveShopifyTestDir,
} from "./project-boundary.js";

export interface LoadShopifyConfigOptions {
	readonly environment: NodeJS.ProcessEnv;
	readonly projectRoot: string;
}

export interface LoadedShopifyConfig {
	readonly configPath: string;
	readonly projectRoot: string;
	readonly roles: readonly string[];
	readonly testDir: string;
}

const readDataProperty = (
	value: Record<PropertyKey, unknown>,
	key: string,
	configPath: string,
): unknown => {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor || !("value" in descriptor)) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config ${key} must be a plain data property: ${configPath}`,
		);
	}
	return descriptor.value;
};

const markedConfig = (
	configPath: string,
	value: unknown,
): DefinedShopifyE2EConfig => {
	if (!isDefinedShopifyE2EConfig(value)) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config must default-export the direct result of defineShopifyE2EConfig. Import it from @sematico/shopify-e2e/config and use export default defineShopifyE2EConfig({...}): ${configPath}`,
		);
	}
	return value;
};

const withConfigContext = (
	configPath: string,
	error: unknown,
): ShopifyE2EPreflightError => {
	if (error instanceof ShopifyE2EPreflightError) return error;
	if (isShopifyE2EConfigContractError(error)) {
		return new ShopifyE2EPreflightError(`${error.message}: ${configPath}`, {
			cause: error,
		});
	}
	return new ShopifyE2EPreflightError(
		`Dedicated Shopify config could not load: ${configPath}`,
		{ cause: error },
	);
};

export const loadShopifyConfig = async (
	options: LoadShopifyConfigOptions,
): Promise<LoadedShopifyConfig> => {
	const configPath = await resolveShopifyConfigPath({
		projectRoot: options.projectRoot,
	});
	try {
		assertReservedExecutionEnvironmentIsClear(options.environment);
	} catch (error) {
		throw new ShopifyE2EPreflightError(
			error instanceof Error
				? error.message
				: "Reserved Shopify E2E execution environment key must not be set",
			{ cause: error },
		);
	}

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

		const playwrightConfig = markedConfig(configPath, moduleNamespace.default);
		const roles = readDataProperty(
			playwrightConfig as Record<PropertyKey, unknown>,
			"roles",
			configPath,
		) as readonly string[];
		const configuredTestDir = readDataProperty(
			playwrightConfig as Record<PropertyKey, unknown>,
			"testDir",
			configPath,
		) as string;
		const testDir = await resolveShopifyTestDir({
			configuredTestDir,
			projectRoot: options.projectRoot,
		});
		return {
			configPath,
			projectRoot: options.projectRoot,
			roles,
			testDir,
		};
	} catch (error) {
		throw withConfigContext(configPath, error);
	}
};
