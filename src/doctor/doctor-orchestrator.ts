import { discoverShopifySpecs } from "../config/discover-specs.js";
import {
	type LoadedShopifyConfig,
	loadShopifyConfig,
} from "../config/load-config.js";
import { resolveProjectRoot } from "../config/project-boundary.js";
import { loadProjectEnvironment } from "../environment/load-environment.js";
import { ShopifyE2EPreflightError } from "../errors.js";
import {
	loadConsumerChromium,
	resolvePlaywrightPeer,
} from "../playwright/peer.js";
import {
	CommandSignalError,
	runWithCommandSignal,
	throwIfCommandAborted,
} from "../process/command-signals.js";
import { configuredOriginFromEnvironment } from "../role-states/configured-origin.cjs";

export const DOCTOR_CHECK_ORDER = [
	"project",
	"environment",
	"store-url",
	"config",
	"specs",
	"playwright-peer",
	"chromium",
] as const;

export type DoctorCheckId = (typeof DOCTOR_CHECK_ORDER)[number];
type DoctorCheckStatus = "PASS" | "FAIL" | "ERROR" | "SKIP";

interface DoctorCheckResult {
	readonly detail: string;
	readonly id: DoctorCheckId;
	readonly status: DoctorCheckStatus;
}

export interface DoctorReport {
	readonly checks: readonly DoctorCheckResult[];
	readonly exitCode: 0 | 1 | 2;
}

interface DoctorOptions {
	readonly cwd: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly signal: AbortSignal;
}

export interface DoctorDependencies {
	readonly discoverSpecs: typeof discoverShopifySpecs;
	readonly loadChromium: typeof loadConsumerChromium;
	readonly loadConfig: typeof loadShopifyConfig;
	readonly loadProjectEnvironment: typeof loadProjectEnvironment;
	readonly configuredOriginFromEnvironment: typeof configuredOriginFromEnvironment;
	readonly resolvePeer: typeof resolvePlaywrightPeer;
	readonly resolveProjectRoot: typeof resolveProjectRoot;
}

interface OrchestrateDoctorArgs {
	readonly dependencies?: DoctorDependencies;
	readonly options: DoctorOptions;
}

const defaultDoctorDependencies: DoctorDependencies = {
	discoverSpecs: discoverShopifySpecs,
	loadChromium: loadConsumerChromium,
	loadConfig: loadShopifyConfig,
	loadProjectEnvironment,
	configuredOriginFromEnvironment,
	resolvePeer: resolvePlaywrightPeer,
	resolveProjectRoot,
};

const pass = (id: DoctorCheckId, detail: string): DoctorCheckResult => ({
	detail,
	id,
	status: "PASS",
});

const skip = (
	id: DoctorCheckId,
	prerequisite: DoctorCheckId,
): DoctorCheckResult => ({
	detail: `Skipped because ${prerequisite} did not pass`,
	id,
	status: "SKIP",
});

const classifyError = (
	id: DoctorCheckId,
	error: unknown,
	detail?: string,
): DoctorCheckResult => {
	if (error instanceof CommandSignalError) throw error;
	if (error instanceof ShopifyE2EPreflightError) {
		return { detail: detail ?? error.message, id, status: "FAIL" };
	}
	return {
		detail: "Unexpected inspection failure",
		id,
		status: "ERROR",
	};
};

const classifyStoreUrlError = (
	error: unknown,
	detail: string,
): DoctorCheckResult => {
	if (error instanceof TypeError) {
		return { detail, id: "store-url", status: "FAIL" };
	}
	return classifyError("store-url", error, detail);
};

const reportFrom = (
	results: ReadonlyMap<DoctorCheckId, DoctorCheckResult>,
): DoctorReport => {
	const checks = DOCTOR_CHECK_ORDER.map((id) => {
		const result = results.get(id);
		if (!result) throw new Error(`Missing doctor result for ${id}`);
		return result;
	});
	let exitCode: DoctorReport["exitCode"] = 0;
	if (checks.some(({ status }) => status === "ERROR")) exitCode = 1;
	else if (checks.some(({ status }) => status === "FAIL")) exitCode = 2;
	return { checks, exitCode };
};

const runAsyncCheck = async <Value>(
	id: DoctorCheckId,
	operation: () => Promise<Value>,
	signal: AbortSignal,
): Promise<
	| { readonly result: DoctorCheckResult; readonly value?: never }
	| { readonly result?: never; readonly value: Value }
> => {
	try {
		return { value: await runWithCommandSignal(operation, signal) };
	} catch (error) {
		return { result: classifyError(id, error) };
	}
};

export const orchestrateDoctor = async ({
	dependencies = defaultDoctorDependencies,
	options,
}: OrchestrateDoctorArgs): Promise<DoctorReport> => {
	const results = new Map<DoctorCheckId, DoctorCheckResult>();
	throwIfCommandAborted(options.signal);

	const project = await runAsyncCheck(
		"project",
		() => dependencies.resolveProjectRoot(options.cwd),
		options.signal,
	);
	if (project.result) {
		results.set("project", project.result);
		for (const id of DOCTOR_CHECK_ORDER.slice(1)) {
			results.set(id, skip(id, "project"));
		}
		return reportFrom(results);
	}
	const projectRoot = project.value;
	results.set("project", pass("project", "Physical consumer root resolved"));

	const environment = await runAsyncCheck(
		"environment",
		() =>
			dependencies.loadProjectEnvironment({
				environment: options.environment,
				projectRoot,
			}),
		options.signal,
	);

	let configuredOrigin: string | undefined;
	let loadedConfig: LoadedShopifyConfig | undefined;
	if (environment.result) {
		results.set("environment", environment.result);
		results.set("store-url", skip("store-url", "environment"));
		results.set("config", skip("config", "environment"));
		results.set("specs", skip("specs", "config"));
	} else {
		results.set(
			"environment",
			pass("environment", "Consumer .env loaded or absent"),
		);
		try {
			throwIfCommandAborted(options.signal);
			configuredOrigin = dependencies.configuredOriginFromEnvironment(
				options.environment,
			);
			results.set(
				"store-url",
				pass("store-url", "SHOPIFY_STORE_URL is a valid HTTPS origin"),
			);
		} catch (error) {
			results.set(
				"store-url",
				classifyStoreUrlError(
					error,
					"SHOPIFY_STORE_URL must be an absolute HTTPS URL without credentials",
				),
			);
		}

		const config = await runAsyncCheck(
			"config",
			() =>
				dependencies.loadConfig({
					environment: options.environment,
					projectRoot,
				}),
			options.signal,
		);
		if (config.result) {
			results.set("config", config.result);
			results.set("specs", skip("specs", "config"));
		} else {
			loadedConfig = config.value;
			results.set(
				"config",
				pass(
					"config",
					`Package-owned Shopify config checks passed: ${config.value.configPath}`,
				),
			);
		}

		if (configuredOrigin !== undefined) {
			try {
				if (
					dependencies.configuredOriginFromEnvironment(options.environment) !==
					configuredOrigin
				) {
					throw new ShopifyE2EPreflightError("Configured origin changed");
				}
			} catch (error) {
				results.set(
					"store-url",
					classifyStoreUrlError(
						error,
						"Trusted config must not remove or change SHOPIFY_STORE_URL origin",
					),
				);
			}
		}
	}

	if (loadedConfig) {
		const specs = await runAsyncCheck(
			"specs",
			() => dependencies.discoverSpecs(loadedConfig.testDir),
			options.signal,
		);
		if (specs.result) results.set("specs", specs.result);
		else {
			results.set(
				"specs",
				pass(
					"specs",
					`${specs.value.length} JavaScript/TypeScript file candidate(s) found: ${loadedConfig.testDir}`,
				),
			);
		}
	}

	const peer = await runAsyncCheck(
		"playwright-peer",
		() => dependencies.resolvePeer(projectRoot),
		options.signal,
	);
	if (peer.result) {
		results.set("playwright-peer", peer.result);
		results.set("chromium", skip("chromium", "playwright-peer"));
	} else {
		results.set(
			"playwright-peer",
			pass("playwright-peer", "Compatible consumer @playwright/test resolved"),
		);
		const chromium = await runAsyncCheck(
			"chromium",
			() => dependencies.loadChromium(peer.value),
			options.signal,
		);
		if (chromium.result) results.set("chromium", chromium.result);
		else {
			results.set(
				"chromium",
				pass("chromium", "Expected Chromium executable file is installed"),
			);
		}
	}

	return reportFrom(results);
};
