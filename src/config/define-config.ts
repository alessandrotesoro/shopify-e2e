import type { PlaywrightTestConfig } from "@playwright/test";

import { readPlaywrightExecutionContext } from "../playwright/execution-context.js";
import { validateRoleList } from "../roles/role-name.js";
import {
	buildRoleTokenPattern,
	ROLE_TOKEN_PREFIX,
} from "../roles/role-token.js";
import { SHOPIFY_E2E_EXECUTION_CONTEXT_ENV } from "./execution-environment.js";
import type { ShopifyLaunchOptionKey } from "./launch-options.js";

const CONFIG_BRAND = Symbol.for("@sematico/shopify-e2e/config/defined");
const CONFIG_ERROR_BRAND = Symbol.for(
	"@sematico/shopify-e2e/config/contract-error",
);

const PROTECTED_ROOT_SETTINGS = [
	"projects",
	"workers",
	"grep",
	"grepInvert",
] as const;

type ProtectedRootSetting = (typeof PROTECTED_ROOT_SETTINGS)[number];
type PlaywrightUse<TestArgs, WorkerArgs> = NonNullable<
	PlaywrightTestConfig<TestArgs, WorkerArgs>["use"]
>;
type PlaywrightLaunchOptions<TestArgs, WorkerArgs> = NonNullable<
	PlaywrightUse<TestArgs, WorkerArgs>["launchOptions"]
>;
type ShopifyLaunchOptions<TestArgs, WorkerArgs> = Pick<
	PlaywrightLaunchOptions<TestArgs, WorkerArgs>,
	ShopifyLaunchOptionKey
>;

export type ShopifyE2EConfig<TestArgs = object, WorkerArgs = object> = Omit<
	PlaywrightTestConfig<TestArgs, WorkerArgs>,
	ProtectedRootSetting | "testDir" | "use"
> & {
	readonly grep?: never;
	readonly grepInvert?: never;
	readonly projects?: never;
	readonly roles: readonly string[];
	readonly testDir: string;
	readonly use?: Omit<
		PlaywrightUse<TestArgs, WorkerArgs>,
		"browserName" | "connectOptions" | "launchOptions" | "storageState"
	> & {
		readonly browserName?: "chromium";
		readonly connectOptions?: never;
		readonly launchOptions?: ShopifyLaunchOptions<TestArgs, WorkerArgs>;
		readonly storageState?: never;
	};
	readonly workers?: never;
};

export type DefinedShopifyE2EConfig<
	TestArgs = object,
	WorkerArgs = object,
> = ShopifyE2EConfig<TestArgs, WorkerArgs>;

class ShopifyE2EConfigContractError extends TypeError {
	public constructor(message: string) {
		super(message);
		this.name = "ShopifyE2EConfigContractError";
		Object.defineProperty(this, CONFIG_ERROR_BRAND, {
			configurable: false,
			enumerable: false,
			value: true,
			writable: false,
		});
	}
}

export const isShopifyE2EConfigContractError = (
	value: unknown,
): value is Error =>
	value instanceof Error &&
	Object.getOwnPropertyDescriptor(value, CONFIG_ERROR_BRAND)?.value === true;

const isPlainRecord = (
	value: unknown,
): value is Record<PropertyKey, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
};

const readDataProperty = (
	value: Record<PropertyKey, unknown>,
	key: PropertyKey,
	label: string,
): unknown => {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor || !("value" in descriptor)) {
		throw new TypeError(`${label} must be a plain data property`);
	}
	return descriptor.value;
};

const assertNoSymbolProperties = (
	value: Record<PropertyKey, unknown>,
	label: string,
): void => {
	if (Object.getOwnPropertySymbols(value).length > 0) {
		throw new TypeError(`${label} must not contain symbol properties`);
	}
};

const assertProtectedSettingIsAbsent = (
	config: Record<PropertyKey, unknown>,
	setting: ProtectedRootSetting,
): void => {
	if (!Object.hasOwn(config, setting)) return;
	const selected = readDataProperty(
		config,
		setting,
		`Shopify config ${setting}`,
	);
	if (selected !== undefined) {
		throw new TypeError(
			`Shopify config ${setting} is controlled by @sematico/shopify-e2e and must not be set`,
		);
	}
};

const assertProtectedUseSettingIsAbsent = (
	use: Record<PropertyKey, unknown>,
	setting: "connectOptions" | "storageState",
): void => {
	if (!Object.hasOwn(use, setting)) return;
	const selected = readDataProperty(
		use,
		setting,
		`Shopify config use.${setting}`,
	);
	if (selected !== undefined) {
		throw new TypeError(
			`Shopify config use.${setting} is controlled by @sematico/shopify-e2e and must not be set`,
		);
	}
};

const assertRoleTokenIsAbsent = (
	config: Record<PropertyKey, unknown>,
	setting: "name" | "tag",
): void => {
	if (!Object.hasOwn(config, setting)) return;
	const selected = readDataProperty(
		config,
		setting,
		`Shopify config ${setting}`,
	);
	const values = Array.isArray(selected) ? selected : [selected];
	if (
		values.some(
			(value) => typeof value === "string" && value.includes(ROLE_TOKEN_PREFIX),
		)
	) {
		throw new TypeError(
			`Shopify config ${setting} must not contain the reserved ${ROLE_TOKEN_PREFIX} token prefix`,
		);
	}
};

const validateUse = (
	config: Record<PropertyKey, unknown>,
): Record<PropertyKey, unknown> | undefined => {
	if (!Object.hasOwn(config, "use")) return undefined;
	const use = readDataProperty(config, "use", "Shopify config use");
	if (use === undefined) return undefined;
	if (!isPlainRecord(use)) {
		throw new TypeError("Shopify config use must be a plain object");
	}
	assertNoSymbolProperties(use, "Shopify config use");
	for (const key of Object.getOwnPropertyNames(use)) {
		readDataProperty(use, key, `Shopify config use.${key}`);
	}
	assertProtectedUseSettingIsAbsent(use, "storageState");
	assertProtectedUseSettingIsAbsent(use, "connectOptions");
	if (Object.hasOwn(use, "browserName")) {
		const browserName = readDataProperty(
			use,
			"browserName",
			"Shopify config use.browserName",
		);
		if (browserName !== undefined && browserName !== "chromium") {
			throw new TypeError(
				"Shopify config use.browserName must be chromium when set",
			);
		}
	}
	return use;
};

const validateInput = (
	input: unknown,
): {
	readonly input: Record<PropertyKey, unknown>;
	readonly roles: readonly string[];
	readonly use: Record<PropertyKey, unknown> | undefined;
} => {
	if (!isPlainRecord(input)) {
		throw new TypeError("Shopify config must be a plain object");
	}
	assertNoSymbolProperties(input, "Shopify config");
	for (const key of Object.getOwnPropertyNames(input)) {
		readDataProperty(input, key, `Shopify config ${key}`);
	}
	for (const setting of PROTECTED_ROOT_SETTINGS) {
		assertProtectedSettingIsAbsent(input, setting);
	}
	assertRoleTokenIsAbsent(input, "name");
	assertRoleTokenIsAbsent(input, "tag");

	const testDir = readDataProperty(input, "testDir", "Shopify config testDir");
	if (typeof testDir !== "string" || testDir.trim().length === 0) {
		throw new TypeError("Shopify config testDir must be a non-empty string");
	}
	const roles = validateRoleList(
		readDataProperty(input, "roles", "Shopify config roles"),
	);
	return { input, roles, use: validateUse(input) };
};

export const isDefinedShopifyE2EConfig = (
	value: unknown,
): value is DefinedShopifyE2EConfig => {
	if (!isPlainRecord(value)) return false;
	const descriptor = Object.getOwnPropertyDescriptor(value, CONFIG_BRAND);
	return (
		descriptor?.value === true &&
		descriptor.enumerable === false &&
		descriptor.configurable === false &&
		descriptor.writable === false
	);
};

export const defineShopifyE2EConfig = <TestArgs = object, WorkerArgs = object>(
	input: ShopifyE2EConfig<TestArgs, WorkerArgs>,
): DefinedShopifyE2EConfig<TestArgs, WorkerArgs> => {
	try {
		const validated = validateInput(input);
		const executionContext = Object.hasOwn(
			process.env,
			SHOPIFY_E2E_EXECUTION_CONTEXT_ENV,
		)
			? readPlaywrightExecutionContext()
			: undefined;
		if (
			executionContext !== undefined &&
			!validated.roles.includes(executionContext.role)
		) {
			throw new TypeError(
				`Selected role is not present in Shopify config roles: ${executionContext.role}`,
			);
		}
		const config = {
			...validated.input,
			roles: validated.roles,
			...(validated.use === undefined ? {} : { use: { ...validated.use } }),
		} as DefinedShopifyE2EConfig<TestArgs, WorkerArgs>;
		if (executionContext !== undefined) {
			Object.assign(config, {
				grep: buildRoleTokenPattern(executionContext.role),
				testDir: executionContext.testDir,
				use: {
					...validated.use,
					storageState: executionContext.state,
				},
				workers: 1,
			});
		}
		Object.defineProperty(config, CONFIG_BRAND, {
			configurable: false,
			enumerable: false,
			value: true,
			writable: false,
		});
		return config;
	} catch (error) {
		if (isShopifyE2EConfigContractError(error)) throw error;
		throw new ShopifyE2EConfigContractError(
			error instanceof Error ? error.message : "Shopify config is invalid",
		);
	}
};
