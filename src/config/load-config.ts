import { createJiti } from "jiti";

import { ShopifyE2EPreflightError } from "../errors.js";
import type { BrowserServerLaunchOptions } from "../playwright/peer.js";
import {
	type DefinedShopifyE2EConfig,
	isDefinedShopifyE2EConfig,
	isShopifyE2EConfigContractError,
} from "./define-config.js";
import { assertPlaywrightExecutionEnvironmentIsSafe } from "./execution-environment.js";
import { SHOPIFY_LAUNCH_OPTION_KEYS } from "./launch-options.js";
import {
	resolveShopifyConfigPath,
	resolveShopifyTestDir,
} from "./project-boundary.js";

export interface LoadShopifyConfigOptions {
	readonly environment: NodeJS.ProcessEnv;
	readonly projectRoot: string;
}

export interface LoadedShopifyConfig {
	readonly browserLaunchOptions: BrowserServerLaunchOptions;
	readonly configPath: string;
	readonly projectRoot: string;
	readonly roles: readonly string[];
	readonly testDir: string;
}

const SUPPORTED_LAUNCH_OPTION_KEYS = new Set<string>(
	SHOPIFY_LAUNCH_OPTION_KEYS,
);

const isPlainRecord = (
	value: unknown,
): value is Record<PropertyKey, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
};

interface AssertPlainRecordArgs {
	value: unknown;
	label: string;
}

const assertPlainRecord = ({
	value,
	label,
}: AssertPlainRecordArgs): Record<PropertyKey, unknown> => {
	if (!isPlainRecord(value)) {
		throw new ShopifyE2EPreflightError(`${label} must be a plain object`);
	}
	if (Object.getOwnPropertySymbols(value).length > 0) {
		throw new ShopifyE2EPreflightError(
			`${label} must not contain symbol properties`,
		);
	}
	for (const key of Object.getOwnPropertyNames(value)) {
		readDataProperty({ value, key, configPath: label });
	}
	return value;
};

interface ReadOptionalStringArgs {
	value: Record<PropertyKey, unknown>;
	key: string;
	label: string;
}

const readOptionalString = ({
	value,
	key,
	label,
}: ReadOptionalStringArgs): string | undefined => {
	if (!Object.hasOwn(value, key)) return undefined;
	const selected = readDataProperty({ value, key, configPath: label });
	if (selected === undefined) return undefined;
	if (typeof selected !== "string" || selected.trim().length === 0) {
		throw new ShopifyE2EPreflightError(`${label} must be a non-empty string`);
	}
	return selected;
};

interface ReadOptionalBooleanArgs {
	value: Record<PropertyKey, unknown>;
	key: string;
	label: string;
}

const readOptionalBoolean = ({
	value,
	key,
	label,
}: ReadOptionalBooleanArgs): boolean | undefined => {
	if (!Object.hasOwn(value, key)) return undefined;
	const selected = readDataProperty({ value, key, configPath: label });
	if (selected === undefined) return undefined;
	if (typeof selected !== "boolean") {
		throw new ShopifyE2EPreflightError(`${label} must be a boolean`);
	}
	return selected;
};

interface ReadOptionalNumberArgs {
	value: Record<PropertyKey, unknown>;
	key: string;
	label: string;
}

const readOptionalNumber = ({
	value,
	key,
	label,
}: ReadOptionalNumberArgs): number | undefined => {
	if (!Object.hasOwn(value, key)) return undefined;
	const selected = readDataProperty({ value, key, configPath: label });
	if (
		selected === undefined ||
		(typeof selected === "number" && Number.isFinite(selected) && selected >= 0)
	) {
		return selected;
	}
	throw new ShopifyE2EPreflightError(
		`${label} must be a non-negative finite number`,
	);
};

interface FreezeStringArrayArgs {
	value: unknown;
	label: string;
}

const freezeStringArray = ({
	value,
	label,
}: FreezeStringArrayArgs): readonly string[] => {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new ShopifyE2EPreflightError(`${label} must be an array of strings`);
	}
	return Object.freeze([...value]);
};

const normalizeEnvironment = (
	value: unknown,
): Readonly<Record<string, string | undefined>> => {
	const input = assertPlainRecord({
		value,
		label: "Shopify config use.launchOptions.env",
	});
	const normalized: Record<string, string | undefined> = {};
	for (const key of Object.getOwnPropertyNames(input)) {
		const selected = readDataProperty({
			value: input,
			key,
			configPath: `Shopify config use.launchOptions.env.${key}`,
		});
		if (selected !== undefined && typeof selected !== "string") {
			throw new ShopifyE2EPreflightError(
				`Shopify config use.launchOptions.env.${key} must be a string or undefined`,
			);
		}
		normalized[key] = selected;
	}
	return Object.freeze(normalized);
};

const normalizeProxy = (
	value: unknown,
): NonNullable<BrowserServerLaunchOptions["proxy"]> => {
	const input = assertPlainRecord({
		value,
		label: "Shopify config use.launchOptions.proxy",
	});
	const supported = new Set(["server", "bypass", "username", "password"]);
	for (const key of Object.getOwnPropertyNames(input)) {
		if (!supported.has(key)) {
			throw new ShopifyE2EPreflightError(
				`Shopify config use.launchOptions.proxy.${key} is not supported`,
			);
		}
	}
	const server = readOptionalString({
		value: input,
		key: "server",
		label: "Shopify config use.launchOptions.proxy.server",
	});
	if (server === undefined) {
		throw new ShopifyE2EPreflightError(
			"Shopify config use.launchOptions.proxy.server must be a non-empty string",
		);
	}
	const bypass = readOptionalString({
		value: input,
		key: "bypass",
		label: "Shopify config use.launchOptions.proxy.bypass",
	});
	const password = readOptionalString({
		value: input,
		key: "password",
		label: "Shopify config use.launchOptions.proxy.password",
	});
	const username = readOptionalString({
		value: input,
		key: "username",
		label: "Shopify config use.launchOptions.proxy.username",
	});
	return Object.freeze({
		...(bypass === undefined ? {} : { bypass }),
		...(password === undefined ? {} : { password }),
		server,
		...(username === undefined ? {} : { username }),
	});
};

const isRemoteDebuggingArgument = (value: string): boolean =>
	/^\s*--remote-debugging(?:[-=]|$)/i.test(value);

const isHeadlessArgument = (value: string): boolean =>
	/^\s*--headless(?:=|$)/i.test(value);

const normalizeBrowserLaunchOptions = (
	config: Record<PropertyKey, unknown>,
): BrowserServerLaunchOptions => {
	const useValue = Object.hasOwn(config, "use")
		? readDataProperty({
				value: config,
				key: "use",
				configPath: "Shopify config use",
			})
		: undefined;
	const use =
		useValue === undefined
			? undefined
			: assertPlainRecord({ value: useValue, label: "Shopify config use" });
	const launchValue =
		use && Object.hasOwn(use, "launchOptions")
			? readDataProperty({
					value: use,
					key: "launchOptions",
					configPath: "Shopify config use.launchOptions",
				})
			: undefined;
	const launch =
		launchValue === undefined
			? undefined
			: assertPlainRecord({
					value: launchValue,
					label: "Shopify config use.launchOptions",
				});
	if (launch) {
		for (const key of Object.getOwnPropertyNames(launch)) {
			if (!SUPPORTED_LAUNCH_OPTION_KEYS.has(key)) {
				throw new ShopifyE2EPreflightError(
					`Shopify config use.launchOptions.${key} is not supported by the shared Chromium server`,
				);
			}
		}
	}

	const argsValue =
		launch && Object.hasOwn(launch, "args")
			? readDataProperty({
					value: launch,
					key: "args",
					configPath: "Shopify config use.launchOptions.args",
				})
			: undefined;
	const args =
		argsValue === undefined
			? undefined
			: freezeStringArray({
					value: argsValue,
					label: "Shopify config use.launchOptions.args",
				});
	if (args?.some(isRemoteDebuggingArgument)) {
		throw new ShopifyE2EPreflightError(
			"Shopify config use.launchOptions.args must not contain --remote-debugging-* options",
		);
	}
	if (args?.some(isHeadlessArgument)) {
		throw new ShopifyE2EPreflightError(
			"Shopify config use.launchOptions.args must not enable headless Chromium",
		);
	}
	const ignoreDefaultArgsValue =
		launch && Object.hasOwn(launch, "ignoreDefaultArgs")
			? readDataProperty({
					value: launch,
					key: "ignoreDefaultArgs",
					configPath: "Shopify config use.launchOptions.ignoreDefaultArgs",
				})
			: undefined;
	let ignoreDefaultArgs: boolean | readonly string[] | undefined;
	if (ignoreDefaultArgsValue !== undefined) {
		if (ignoreDefaultArgsValue === true) {
			throw new ShopifyE2EPreflightError(
				"Shopify config use.launchOptions.ignoreDefaultArgs must not disable Chromium's required native transport",
			);
		}
		if (typeof ignoreDefaultArgsValue === "boolean") {
			ignoreDefaultArgs = ignoreDefaultArgsValue;
		} else {
			ignoreDefaultArgs = freezeStringArray({
				value: ignoreDefaultArgsValue,
				label: "Shopify config use.launchOptions.ignoreDefaultArgs",
			});
			if (ignoreDefaultArgs.includes("--remote-debugging-pipe")) {
				throw new ShopifyE2EPreflightError(
					"Shopify config use.launchOptions.ignoreDefaultArgs must not remove Chromium's required native transport",
				);
			}
		}
	}

	const launchChannel = launch
		? readOptionalString({
				value: launch,
				key: "channel",
				label: "Shopify config use.launchOptions.channel",
			})
		: undefined;
	const useChannel = use
		? readOptionalString({
				value: use,
				key: "channel",
				label: "Shopify config use.channel",
			})
		: undefined;
	const channel = useChannel ?? launchChannel;
	const artifactsDir = launch
		? readOptionalString({
				value: launch,
				key: "artifactsDir",
				label: "Shopify config use.launchOptions.artifactsDir",
			})
		: undefined;
	const chromiumSandbox = launch
		? readOptionalBoolean({
				value: launch,
				key: "chromiumSandbox",
				label: "Shopify config use.launchOptions.chromiumSandbox",
			})
		: undefined;
	const downloadsPath = launch
		? readOptionalString({
				value: launch,
				key: "downloadsPath",
				label: "Shopify config use.launchOptions.downloadsPath",
			})
		: undefined;
	const executablePath = launch
		? readOptionalString({
				value: launch,
				key: "executablePath",
				label: "Shopify config use.launchOptions.executablePath",
			})
		: undefined;
	const timeout = launch
		? readOptionalNumber({
				value: launch,
				key: "timeout",
				label: "Shopify config use.launchOptions.timeout",
			})
		: undefined;
	const envValue =
		launch && Object.hasOwn(launch, "env")
			? readDataProperty({
					value: launch,
					key: "env",
					configPath: "Shopify config use.launchOptions.env",
				})
			: undefined;
	const proxyValue =
		launch && Object.hasOwn(launch, "proxy")
			? readDataProperty({
					value: launch,
					key: "proxy",
					configPath: "Shopify config use.launchOptions.proxy",
				})
			: undefined;
	return Object.freeze({
		...(args === undefined ? {} : { args }),
		...(artifactsDir === undefined ? {} : { artifactsDir }),
		...(channel === undefined ? {} : { channel }),
		...(chromiumSandbox === undefined ? {} : { chromiumSandbox }),
		...(downloadsPath === undefined ? {} : { downloadsPath }),
		...(envValue === undefined ? {} : { env: normalizeEnvironment(envValue) }),
		...(executablePath === undefined ? {} : { executablePath }),
		handleSIGHUP: true,
		handleSIGINT: false,
		handleSIGTERM: false,
		headless: false,
		host: "127.0.0.1",
		...(ignoreDefaultArgs === undefined ? {} : { ignoreDefaultArgs }),
		port: 0,
		...(proxyValue === undefined ? {} : { proxy: normalizeProxy(proxyValue) }),
		...(timeout === undefined ? {} : { timeout }),
	});
};

interface ReadDataPropertyArgs {
	value: Record<PropertyKey, unknown>;
	key: string;
	configPath: string;
}

const readDataProperty = ({
	value,
	key,
	configPath,
}: ReadDataPropertyArgs): unknown => {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (!descriptor || !("value" in descriptor)) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config ${key} must be a plain data property: ${configPath}`,
		);
	}
	return descriptor.value;
};

interface MarkedConfigArgs {
	configPath: string;
	value: unknown;
}

const markedConfig = ({
	configPath,
	value,
}: MarkedConfigArgs): DefinedShopifyE2EConfig => {
	if (!isDefinedShopifyE2EConfig(value)) {
		throw new ShopifyE2EPreflightError(
			`Dedicated Shopify config must default-export the direct result of defineShopifyE2EConfig. Import it from @sematico/shopify-e2e/config and use export default defineShopifyE2EConfig({...}): ${configPath}`,
		);
	}
	return value;
};

interface WithConfigContextArgs {
	configPath: string;
	error: unknown;
}

const withConfigContext = ({
	configPath,
	error,
}: WithConfigContextArgs): ShopifyE2EPreflightError => {
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

const assertExecutionEnvironmentIsSafe = (
	environment: NodeJS.ProcessEnv,
): void => {
	try {
		assertPlaywrightExecutionEnvironmentIsSafe(environment);
	} catch (error) {
		throw new ShopifyE2EPreflightError(
			error instanceof Error
				? error.message
				: "Reserved Shopify E2E execution environment key must not be set",
			{ cause: error },
		);
	}
};

export const loadShopifyConfig = async (
	options: LoadShopifyConfigOptions,
): Promise<LoadedShopifyConfig> => {
	const configPath = await resolveShopifyConfigPath({
		projectRoot: options.projectRoot,
	});
	assertExecutionEnvironmentIsSafe(options.environment);

	try {
		const jiti = createJiti(import.meta.url, {
			fsCache: false,
			interopDefault: false,
			moduleCache: false,
		});
		const moduleNamespace =
			await jiti.import<Record<PropertyKey, unknown>>(configPath);
		assertExecutionEnvironmentIsSafe(options.environment);
		if (!Object.hasOwn(moduleNamespace, "default")) {
			throw new ShopifyE2EPreflightError(
				`Dedicated Shopify config must have a default export: ${configPath}`,
			);
		}

		const playwrightConfig = markedConfig({
			configPath,
			value: moduleNamespace.default,
		});
		const roles = readDataProperty({
			value: playwrightConfig as Record<PropertyKey, unknown>,
			key: "roles",
			configPath,
		}) as readonly string[];
		const configuredTestDir = readDataProperty({
			value: playwrightConfig as Record<PropertyKey, unknown>,
			key: "testDir",
			configPath,
		}) as string;
		const testDir = await resolveShopifyTestDir({
			configuredTestDir,
			projectRoot: options.projectRoot,
		});
		return {
			browserLaunchOptions: normalizeBrowserLaunchOptions(
				playwrightConfig as Record<PropertyKey, unknown>,
			),
			configPath,
			projectRoot: options.projectRoot,
			roles,
			testDir,
		};
	} catch (error) {
		throw withConfigContext({ configPath, error });
	}
};
