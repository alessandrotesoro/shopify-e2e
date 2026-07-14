import {
	type LoadedShopifyConfig,
	loadShopifyConfig,
} from "../config/load-config.js";
import {
	type LoadEnvironmentOptions,
	loadEnvironment,
} from "../environment/load-environment.js";
import { ShopifyE2EPreflightError } from "../errors.js";
import {
	loadConsumerChromium,
	resolvePlaywrightPeer,
} from "../playwright/peer.js";
import {
	runWithCommandSignal,
	throwIfCommandAborted,
} from "../process/command-signals.js";
import {
	normalizeConfiguredOrigin,
	resolveProfileDataRoot,
} from "../profiles/configured-origin.js";
import {
	createProfileStore,
	EMPTY_STORAGE_STATE,
	type ProfileSelection,
	type ProfileStore,
	type ProfileSummary,
} from "../profiles/profile-store.js";
import type { PromptFunctions } from "../prompts/inquirer.js";
import { captureBrowserProfile } from "./capture-profile.js";

export type AuthAction = "capture" | "list" | "menu" | "refresh";

export interface AuthOrchestratorOptions {
	readonly action: AuthAction;
	readonly configPath?: string;
	readonly cwd: string;
	readonly dataDir: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly input?: NodeJS.ReadableStream;
	readonly interactive: boolean;
	readonly output?: NodeJS.WritableStream;
	readonly packageRoot: string;
	readonly profile?: string;
	readonly role?: string;
	readonly signal: AbortSignal;
}

export interface AuthOrchestratorDependencies {
	readonly captureProfile: typeof captureBrowserProfile;
	readonly createStore: (options: {
		readonly dataRoot: string;
		readonly origin: string;
		readonly roles: LoadedShopifyConfig["roles"];
	}) => ProfileStore;
	readonly loadConfig: typeof loadShopifyConfig;
	readonly loadEnvironment: (
		options: LoadEnvironmentOptions,
	) => Promise<string>;
	readonly prompts: PromptFunctions;
	readonly report: (message: string) => void;
	readonly resolveDataRoot: typeof resolveProfileDataRoot;
	readonly resolvePeer: typeof resolvePlaywrightPeer;
	readonly loadChromium: typeof loadConsumerChromium;
}

const requireInteractive = (options: AuthOrchestratorOptions): void => {
	if (!options.interactive) {
		throw new ShopifyE2EPreflightError(
			"This auth flow requires an interactive terminal. Use `auth list` for non-interactive inspection.",
		);
	}
};

const createPromptContext = (options: AuthOrchestratorOptions) => ({
	input: options.input,
	output: options.output,
	signal: options.signal,
});

const configuredOriginFromEnvironment = (
	environment: NodeJS.ProcessEnv,
): string => {
	const configuredUrl = environment.SHOPIFY_STORE_URL;
	if (!configuredUrl) {
		throw new ShopifyE2EPreflightError(
			"SHOPIFY_STORE_URL is required. Set it in the consumer .env file or inherited environment.",
		);
	}
	return normalizeConfiguredOrigin(configuredUrl);
};

const selectSavedProfile = async (
	summaries: readonly ProfileSummary[],
	store: ProfileStore,
	options: AuthOrchestratorOptions,
	dependencies: AuthOrchestratorDependencies,
): Promise<Extract<ProfileSelection, { kind: "saved" }>> => {
	const saved = summaries.filter((summary) => summary.status === "runnable");
	if (saved.length === 0) {
		throw new ShopifyE2EPreflightError(
			"No runnable saved profile is available. Capture one first.",
		);
	}
	if (options.profile !== undefined) {
		const selected = saved.find((profile) => profile.name === options.profile);
		if (!selected) {
			throw new ShopifyE2EPreflightError(
				"Requested saved profile is unknown or invalid",
			);
		}
		const resolved = await runWithCommandSignal(
			() => store.resolve(selected.name),
			options.signal,
		);
		if (resolved.kind !== "saved") {
			throw new ShopifyE2EPreflightError(
				"Requested saved profile is unknown or invalid",
			);
		}
		return resolved;
	}
	requireInteractive(options);
	const name = await runWithCommandSignal(
		() =>
			dependencies.prompts.select({
				...createPromptContext(options),
				choices: saved.map((profile) => ({
					name: `${profile.name} - ${profile.role}`,
					value: profile.name,
				})),
				message: "Which profile should be refreshed?",
			}),
		options.signal,
	);
	const selected = saved.find((profile) => profile.name === name);
	if (!selected) {
		throw new ShopifyE2EPreflightError("Selected profile is unavailable");
	}
	const resolved = await runWithCommandSignal(
		() => store.resolve(selected.name),
		options.signal,
	);
	if (resolved.kind !== "saved") {
		throw new ShopifyE2EPreflightError("Selected profile is unavailable");
	}
	return resolved;
};

interface CaptureStateArgs {
	readonly cancellationMessage: string;
	readonly config: LoadedShopifyConfig;
	readonly confirmationMessage: string;
	readonly dependencies: AuthOrchestratorDependencies;
	readonly initialState: ProfileSelection["state"];
	readonly options: AuthOrchestratorOptions;
	readonly origin: string;
}

const captureState = async ({
	cancellationMessage,
	config,
	confirmationMessage,
	dependencies,
	initialState,
	options,
	origin,
}: CaptureStateArgs): Promise<ProfileSelection["state"] | undefined> => {
	const peer = await runWithCommandSignal(
		() => dependencies.resolvePeer(config.projectRoot),
		options.signal,
	);
	const chromium = await runWithCommandSignal(
		() => dependencies.loadChromium(peer),
		options.signal,
	);
	throwIfCommandAborted(options.signal);
	const result = await dependencies.captureProfile({
		dependencies: {
			confirmSave: ({ signal }) =>
				dependencies.prompts.confirm({
					...createPromptContext(options),
					default: false,
					message: confirmationMessage,
					signal,
				}),
			launchChromium: (launchOptions) => chromium.launch(launchOptions),
			report: dependencies.report,
		},
		initialState,
		origin,
		signal: options.signal,
	});
	throwIfCommandAborted(options.signal);
	if (result.status === "cancelled") {
		dependencies.report(cancellationMessage);
		return undefined;
	}
	return result.state;
};

const runCapture = async (
	config: LoadedShopifyConfig,
	store: ProfileStore,
	origin: string,
	options: AuthOrchestratorOptions,
	dependencies: AuthOrchestratorDependencies,
): Promise<void> => {
	requireInteractive(options);
	const authenticatedRoles = Object.entries(config.roles)
		.filter(([, role]) => role.authentication === "required")
		.map(([name]) => name)
		.sort();
	if (authenticatedRoles.length === 0) {
		throw new ShopifyE2EPreflightError(
			"No role with required authentication is configured",
		);
	}
	let role = options.role;
	if (role !== undefined && !authenticatedRoles.includes(role)) {
		throw new ShopifyE2EPreflightError(
			"Capture role must be configured with required authentication",
		);
	}
	role ??= await runWithCommandSignal(
		() =>
			dependencies.prompts.select({
				...createPromptContext(options),
				choices: authenticatedRoles.map((name) => ({ name, value: name })),
				message: "Which role should this profile use?",
			}),
		options.signal,
	);

	let profile = options.profile;
	if (profile !== undefined) {
		const requestedProfile = profile;
		await runWithCommandSignal(
			() => store.assertCaptureNameAvailable(requestedProfile),
			options.signal,
		);
	} else {
		profile = await runWithCommandSignal(
			() =>
				dependencies.prompts.input({
					...createPromptContext(options),
					message:
						"Profile name (lower-kebab, no credentials or personal data):",
					validate: async (value) => {
						try {
							await store.assertCaptureNameAvailable(value);
							return true;
						} catch (error) {
							return error instanceof Error
								? error.message
								: "Profile name is invalid";
						}
					},
				}),
			options.signal,
		);
	}

	const state = await captureState({
		cancellationMessage:
			"Authentication capture cancelled; no profile changed.",
		config,
		confirmationMessage: "Authentication complete. Save this browser profile?",
		dependencies,
		initialState: EMPTY_STORAGE_STATE,
		options,
		origin,
	});
	if (!state) return;
	throwIfCommandAborted(options.signal);
	await store.capture({ name: profile, role, signal: options.signal, state });
	dependencies.report(
		`Saved profile ${profile} for role ${role}. Run \`shopify-e2e run --profile ${profile}\`.`,
	);
};

const runRefresh = async (
	store: ProfileStore,
	origin: string,
	config: LoadedShopifyConfig,
	options: AuthOrchestratorOptions,
	dependencies: AuthOrchestratorDependencies,
	summaries?: readonly ProfileSummary[],
): Promise<void> => {
	requireInteractive(options);
	const selected = await selectSavedProfile(
		summaries ??
			(await runWithCommandSignal(() => store.list(), options.signal)),
		store,
		options,
		dependencies,
	);
	const state = await captureState({
		cancellationMessage:
			"Authentication refresh cancelled; no profile changed.",
		config,
		confirmationMessage:
			"Authentication refreshed. Replace this profile state?",
		dependencies,
		initialState: selected.state,
		options,
		origin,
	});
	if (!state) return;
	throwIfCommandAborted(options.signal);
	await store.refresh({
		name: selected.name,
		signal: options.signal,
		state,
	});
	dependencies.report(
		`Refreshed profile ${selected.name} for role ${selected.role}.`,
	);
};

export const orchestrateAuth = async (
	options: AuthOrchestratorOptions,
	dependencies: AuthOrchestratorDependencies,
): Promise<void> => {
	const projectRoot = await runWithCommandSignal(
		() =>
			dependencies.loadEnvironment({
				cwd: options.cwd,
				environment: options.environment,
			}),
		options.signal,
	);
	throwIfCommandAborted(options.signal);
	const origin = configuredOriginFromEnvironment(options.environment);
	const config = await runWithCommandSignal(
		() =>
			dependencies.loadConfig({
				configPath: options.configPath,
				projectRoot,
			}),
		options.signal,
	);
	const liveOrigin = configuredOriginFromEnvironment(options.environment);
	if (liveOrigin !== origin) {
		throw new ShopifyE2EPreflightError(
			"SHOPIFY_STORE_URL must not change while loading the dedicated Shopify config. Set it in the consumer .env file or inherited environment.",
		);
	}
	const dataRoot = await runWithCommandSignal(
		() =>
			dependencies.resolveDataRoot({
				dataDir: options.dataDir,
				packageRoot: options.packageRoot,
				projectRoot,
			}),
		options.signal,
	);
	throwIfCommandAborted(options.signal);
	const store = dependencies.createStore({
		dataRoot,
		origin,
		roles: config.roles,
	});

	let action = options.action;
	let summaries: readonly ProfileSummary[] | undefined;
	if (action === "menu") {
		requireInteractive(options);
		summaries = await runWithCommandSignal(() => store.list(), options.signal);
		const hasCapture = Object.values(config.roles).some(
			(role) => role.authentication === "required",
		);
		const hasRefresh = summaries.some(
			(summary) => summary.status === "runnable",
		);
		const selectedAction = await runWithCommandSignal(
			() =>
				dependencies.prompts.select({
					...createPromptContext(options),
					choices: [
						{
							disabled: hasCapture
								? false
								: "No authenticated role is configured",
							name: "Capture a profile",
							value: "capture" as const,
						},
						{
							disabled: hasRefresh ? false : "No runnable saved profile exists",
							name: "Refresh a profile",
							value: "refresh" as const,
						},
						{ name: "List profiles", value: "list" as const },
						{ name: "Cancel", value: "cancel" as const },
					],
					message: "Authentication profiles",
				}),
			options.signal,
		);
		if (selectedAction === "cancel") {
			dependencies.report("Authentication menu cancelled; no profile changed.");
			return;
		}
		action = selectedAction;
	}

	if (action === "list") {
		const profiles =
			summaries ??
			(await runWithCommandSignal(() => store.list(), options.signal));
		if (profiles.length === 0) {
			dependencies.report("No saved profiles for the configured store.");
			return;
		}
		for (const profile of profiles) {
			dependencies.report(
				`${profile.name}\t${profile.role}\t${profile.status}`,
			);
		}
		return;
	}
	if (action === "capture") {
		await runCapture(config, store, origin, options, dependencies);
		return;
	}
	await runRefresh(store, origin, config, options, dependencies, summaries);
};

export const defaultAuthDependencies = (
	prompts: PromptFunctions,
	report: (message: string) => void,
): AuthOrchestratorDependencies => ({
	captureProfile: captureBrowserProfile,
	createStore: createProfileStore,
	loadChromium: loadConsumerChromium,
	loadConfig: loadShopifyConfig,
	loadEnvironment,
	prompts,
	report,
	resolveDataRoot: resolveProfileDataRoot,
	resolvePeer: resolvePlaywrightPeer,
});
