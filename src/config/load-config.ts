import { createJiti } from "jiti";

import { ShopifyE2EPreflightError } from "../errors.js";
import { isValidProfileName } from "../profiles/profile-name.js";
import { discoverShopifySpecs } from "./discover-specs.js";
import {
	resolveShopifyConfigPath,
	resolveShopifyTestDir,
} from "./project-boundary.js";

export interface ShopifyE2EConfig {
	readonly roles: Readonly<Record<string, ShopifyRoleConfig>>;
	readonly testDir: string;
}

export interface ShopifyRoleConfig {
	readonly authentication: "none" | "required";
}

export interface LoadShopifyConfigOptions {
	readonly configPath?: string;
	readonly projectRoot: string;
}

export interface LoadedShopifyConfig {
	readonly configPath: string;
	readonly projectRoot: string;
	readonly roles: Readonly<Record<string, ShopifyRoleConfig>>;
	readonly testDir: string;
}

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (
	value: Record<PropertyKey, unknown>,
	expected: readonly string[],
): boolean => {
	const keys = Reflect.ownKeys(value);
	return (
		keys.length === expected.length &&
		expected.every((key) => keys.includes(key)) &&
		keys.every((key) => typeof key === "string" && expected.includes(key))
	);
};

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

const validateRoles = (
	configPath: string,
	value: unknown,
): Readonly<Record<string, ShopifyRoleConfig>> => {
	if (!isRecord(value) || Reflect.ownKeys(value).length === 0) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config roles must be a non-empty plain object: ${configPath}`,
		);
	}

	const roles: Record<string, ShopifyRoleConfig> = {};
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") {
			throw new ShopifyE2EPreflightError(
				`Dedicated Shopify config role names must be strings: ${configPath}`,
			);
		}
		if (!isValidProfileName(key)) {
			throw new ShopifyE2EPreflightError(
				`Role name must be an ASCII lower-kebab name no longer than 64 bytes: ${configPath}`,
			);
		}
		const role = key;
		const roleValue = readDataProperty(value, key, configPath);
		if (!isRecord(roleValue) || !hasExactKeys(roleValue, ["authentication"])) {
			throw new ShopifyE2EPreflightError(
				`Role ${role} must contain exactly authentication: ${configPath}`,
			);
		}
		const authentication = readDataProperty(
			roleValue,
			"authentication",
			configPath,
		);
		if (authentication !== "required" && authentication !== "none") {
			throw new ShopifyE2EPreflightError(
				`Role ${role} authentication must be required or none: ${configPath}`,
			);
		}
		roles[role] = { authentication };
	}
	return Object.freeze(roles);
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

	if (!hasExactKeys(value, ["testDir", "roles"])) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config must contain exactly testDir and roles. Add an explicit roles map when migrating from 0.1.x: ${configPath}`,
		);
	}

	const testDir = readDataProperty(value, "testDir", configPath);
	if (typeof testDir !== "string" || testDir.trim().length === 0) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config testDir must be a non-empty string: ${configPath}`,
		);
	}
	const roles = validateRoles(
		configPath,
		readDataProperty(value, "roles", configPath),
	);
	return { roles, testDir };
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
	const configPath = await resolveShopifyConfigPath({
		explicitConfigPath: options.configPath,
		projectRoot: options.projectRoot,
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
			projectRoot: options.projectRoot,
		});
		return {
			configPath,
			projectRoot: options.projectRoot,
			roles: config.roles,
			testDir,
		};
	} catch (error) {
		throw withConfigContext({ configPath, error });
	}
};

export const loadRunnableShopifyConfig = async (
	options: LoadShopifyConfigOptions,
): Promise<LoadedShopifyConfig> => {
	const config = await loadShopifyConfig(options);
	await discoverShopifySpecs(config.testDir);
	return config;
};
