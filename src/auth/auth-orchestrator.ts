import {
	type LoadedShopifyConfig,
	loadShopifyConfig,
} from "../config/load-config.js";
import {
	type LoadEnvironmentOptions,
	loadEnvironment,
} from "../environment/load-environment.js";
import {
	ShopifyE2EInfrastructureError,
	ShopifyE2EPreflightError,
} from "../errors.js";
import {
	loadConsumerChromium,
	resolvePlaywrightPeer,
} from "../playwright/peer.js";
import {
	runWithCommandSignal,
	throwIfCommandAborted,
} from "../process/command-signals.js";
import type { PromptFunctions } from "../prompts/inquirer.js";
import { configuredOriginFromEnvironment } from "../role-states/configured-origin.cjs";
import { resolveRoleStateDataRoot } from "../role-states/data-root.js";
import {
	createRoleStateStore,
	type RoleStateSelection,
	type RoleStateStore,
	type RoleStateSummary,
} from "../role-states/role-state-store.js";
import { assertRoleName } from "../roles/role-name.cjs";
import type { PlaywrightStorageState } from "../storage-state/schema.cjs";
import { captureBrowserRoleState } from "./capture-role-state.js";

export type AuthAction = "capture" | "list" | "menu" | "refresh" | "remove";

export interface AuthOrchestratorOptions {
	readonly action: AuthAction;
	readonly cwd: string;
	readonly dataDir: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly input?: NodeJS.ReadableStream;
	readonly interactive: boolean;
	readonly output?: NodeJS.WritableStream;
	readonly packageRoot: string;
	readonly role?: string;
	readonly signal: AbortSignal;
	readonly yes?: boolean;
}

export interface AuthOrchestratorDependencies {
	readonly captureRoleState: typeof captureBrowserRoleState;
	readonly createStore: (options: {
		readonly dataRoot: string;
		readonly origin: string;
		readonly roles: readonly string[];
	}) => RoleStateStore;
	readonly loadChromium: typeof loadConsumerChromium;
	readonly loadConfig: typeof loadShopifyConfig;
	readonly loadEnvironment: (
		options: LoadEnvironmentOptions,
	) => Promise<string>;
	readonly prompts: PromptFunctions;
	readonly report: (message: string) => void;
	readonly resolveDataRoot: typeof resolveRoleStateDataRoot;
	readonly resolvePeer: typeof resolvePlaywrightPeer;
}

const EMPTY_STORAGE_STATE: PlaywrightStorageState = {
	cookies: [],
	origins: [],
};

const createPromptContext = (options: AuthOrchestratorOptions) => ({
	input: options.input,
	output: options.output,
	signal: options.signal,
});

const requireInteractive = (
	options: AuthOrchestratorOptions,
	message = "This authentication action requires an interactive terminal. Run it from a terminal with a TTY.",
): void => {
	if (!options.interactive) throw new ShopifyE2EPreflightError(message);
};

const validateTerminalMode = (options: AuthOrchestratorOptions): void => {
	switch (options.action) {
		case "capture":
		case "refresh":
			requireInteractive(options);
			return;
		case "menu":
			requireInteractive(
				options,
				"Bare `shopify-e2e auth` requires an interactive terminal. Use `auth capture`, `auth refresh`, `auth remove`, or `auth list` directly.",
			);
			return;
		case "remove":
			if (
				!options.interactive &&
				(options.role === undefined || options.yes !== true)
			) {
				throw new ShopifyE2EPreflightError(
					"Non-interactive role-state removal requires both --role and --yes",
				);
			}
			return;
		case "list":
			return;
		default: {
			const unsupportedAction: never = options.action;
			throw new ShopifyE2EInfrastructureError(
				"Authentication action could not be resolved",
				{ cause: unsupportedAction },
			);
		}
	}
};

const configuredOrigin = (environment: NodeJS.ProcessEnv): string => {
	try {
		return configuredOriginFromEnvironment(environment);
	} catch (cause) {
		throw new ShopifyE2EPreflightError(
			cause instanceof Error ? cause.message : "SHOPIFY_STORE_URL is invalid",
			{ cause },
		);
	}
};

const roleSummary = (
	summaries: readonly RoleStateSummary[],
	role: string,
): RoleStateSummary | undefined =>
	summaries.find((summary) => summary.role === role);

const unknownRole = (role: string): ShopifyE2EPreflightError =>
	new ShopifyE2EPreflightError(
		`Role ${role} is not configured. Run \`shopify-e2e auth list\` or omit --role in an interactive terminal.`,
	);

const missingState = (role: string): ShopifyE2EPreflightError =>
	new ShopifyE2EPreflightError(
		`Role ${role} has no saved state. Run \`shopify-e2e auth capture --role ${role}\`.`,
	);

const readyCapture = (role: string): ShopifyE2EPreflightError =>
	new ShopifyE2EPreflightError(
		`Role ${role} already has saved state. Run \`shopify-e2e auth refresh --role ${role}\`.`,
	);

const invalidState = (role: string): ShopifyE2EPreflightError =>
	new ShopifyE2EPreflightError(
		`Role ${role} has invalid saved state. Run \`shopify-e2e auth remove --role ${role}\`, then \`shopify-e2e auth capture --role ${role}\`.`,
	);

const unsafeCollision = (role: string): ShopifyE2EPreflightError =>
	new ShopifyE2EPreflightError(
		`Role ${role} has an unsafe filesystem collision. Manual cleanup is required; the CLI will not follow or remove it.`,
	);

const classifyInvalidState = async (
	store: RoleStateStore,
	role: string,
): Promise<ShopifyE2EPreflightError> =>
	(await store.removableRoles()).includes(role)
		? invalidState(role)
		: unsafeCollision(role);

const resolveConfiguredSummary = async (
	config: LoadedShopifyConfig,
	store: RoleStateStore,
	role: string,
): Promise<RoleStateSummary> => {
	try {
		assertRoleName(role);
	} catch (cause) {
		throw new ShopifyE2EPreflightError(
			"Role is invalid. Run `shopify-e2e auth list` or omit --role in an interactive terminal.",
			{ cause },
		);
	}
	if (!config.roles.includes(role)) throw unknownRole(role);
	const summary = roleSummary(await store.list(), role);
	if (!summary) throw unknownRole(role);
	return summary;
};

interface SelectRoleArgs {
	readonly candidates: readonly string[];
	readonly emptyMessage: string;
	readonly message: string;
	readonly options: AuthOrchestratorOptions;
	readonly prompts: PromptFunctions;
}

const selectRole = async ({
	candidates,
	emptyMessage,
	message,
	options,
	prompts,
}: SelectRoleArgs): Promise<string> => {
	if (candidates.length === 0) {
		throw new ShopifyE2EPreflightError(emptyMessage);
	}
	const role = await runWithCommandSignal(
		() =>
			prompts.select({
				...createPromptContext(options),
				choices: candidates.map((candidate) => ({
					name: candidate,
					value: candidate,
				})),
				message,
			}),
		options.signal,
	);
	if (!candidates.includes(role)) {
		throw new ShopifyE2EPreflightError("Selected role is unavailable");
	}
	return role;
};

interface CaptureStateArgs {
	readonly cancellationMessage: string;
	readonly config: LoadedShopifyConfig;
	readonly confirmationMessage: string;
	readonly dependencies: AuthOrchestratorDependencies;
	readonly initialState: PlaywrightStorageState;
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
}: CaptureStateArgs): Promise<PlaywrightStorageState | undefined> => {
	const peer = await runWithCommandSignal(
		() => dependencies.resolvePeer(config.projectRoot),
		options.signal,
	);
	const chromium = await runWithCommandSignal(
		() => dependencies.loadChromium(peer),
		options.signal,
	);
	throwIfCommandAborted(options.signal);
	const result = await dependencies.captureRoleState({
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
	store: RoleStateStore,
	origin: string,
	options: AuthOrchestratorOptions,
	dependencies: AuthOrchestratorDependencies,
): Promise<void> => {
	const summaries = await runWithCommandSignal(
		() => store.list(),
		options.signal,
	);
	const role =
		options.role ??
		(await selectRole({
			candidates: summaries
				.filter((summary) => summary.status === "missing")
				.map((summary) => summary.role),
			emptyMessage:
				"No configured role is missing state. Use `shopify-e2e auth refresh --role <role>` for an existing role state.",
			message: "Which role should be captured?",
			options,
			prompts: dependencies.prompts,
		}));
	const summary = await resolveConfiguredSummary(config, store, role);
	if (summary.status === "ready") throw readyCapture(role);
	if (summary.status === "invalid") {
		throw await classifyInvalidState(store, role);
	}
	if (summary.status !== "missing") throw unknownRole(role);
	await runWithCommandSignal(
		() => store.assertCaptureAvailable(role),
		options.signal,
	);
	const state = await captureState({
		cancellationMessage:
			"Authentication capture cancelled; no role state changed.",
		config,
		confirmationMessage: "Authentication complete. Save this role state?",
		dependencies,
		initialState: EMPTY_STORAGE_STATE,
		options,
		origin,
	});
	if (!state) return;
	throwIfCommandAborted(options.signal);
	await store.capture({ role, signal: options.signal, state });
	dependencies.report(
		`Saved role state for ${role}. Run \`shopify-e2e run --role ${role}\`.`,
	);
};

const runRefresh = async (
	config: LoadedShopifyConfig,
	store: RoleStateStore,
	origin: string,
	options: AuthOrchestratorOptions,
	dependencies: AuthOrchestratorDependencies,
): Promise<void> => {
	const summaries = await runWithCommandSignal(
		() => store.list(),
		options.signal,
	);
	const role =
		options.role ??
		(await selectRole({
			candidates: summaries
				.filter((summary) => summary.status === "ready")
				.map((summary) => summary.role),
			emptyMessage:
				"No configured role has ready state. Run `shopify-e2e auth capture --role <role>` for a missing role.",
			message: "Which role should be refreshed?",
			options,
			prompts: dependencies.prompts,
		}));
	const summary = await resolveConfiguredSummary(config, store, role);
	if (summary.status === "missing") throw missingState(role);
	if (summary.status === "invalid") {
		throw await classifyInvalidState(store, role);
	}
	if (summary.status !== "ready") throw unknownRole(role);
	let selected: RoleStateSelection;
	try {
		selected = await runWithCommandSignal(
			() => store.resolve(role),
			options.signal,
		);
	} catch (error) {
		if (error instanceof ShopifyE2EPreflightError) {
			const latest = await resolveConfiguredSummary(config, store, role);
			if (latest.status === "missing") throw missingState(role);
			if (latest.status === "invalid") {
				throw await classifyInvalidState(store, role);
			}
		}
		throw error;
	}
	const state = await captureState({
		cancellationMessage:
			"Authentication refresh cancelled; no role state changed.",
		config,
		confirmationMessage: "Authentication refreshed. Replace this role state?",
		dependencies,
		initialState: selected.state,
		options,
		origin,
	});
	if (!state) return;
	throwIfCommandAborted(options.signal);
	await store.refresh({ role, signal: options.signal, state });
	dependencies.report(`Refreshed role state for ${role}.`);
};

const runRemove = async (
	store: RoleStateStore,
	options: AuthOrchestratorOptions,
	dependencies: AuthOrchestratorDependencies,
	cachedCandidates?: readonly string[],
): Promise<void> => {
	const skipConfirmation = options.yes === true;
	const candidates =
		cachedCandidates ??
		(await runWithCommandSignal(() => store.removableRoles(), options.signal));
	const role =
		options.role ??
		(await selectRole({
			candidates,
			emptyMessage:
				"No removable role state is available for the configured store.",
			message: "Which role state should be removed?",
			options,
			prompts: dependencies.prompts,
		}));
	if (!candidates.includes(role)) {
		const summary = roleSummary(
			await runWithCommandSignal(() => store.list(), options.signal),
			role,
		);
		if (summary?.status === "invalid") throw unsafeCollision(role);
		throw new ShopifyE2EPreflightError(
			"Role state is unknown or cannot be removed",
		);
	}

	if (!skipConfirmation) {
		const shouldRemove = await runWithCommandSignal(
			() =>
				dependencies.prompts.confirm({
					...createPromptContext(options),
					default: false,
					message: `Remove role state for ${role}? Locally saved browser authentication will be removed.`,
				}),
			options.signal,
		);
		if (!shouldRemove) {
			dependencies.report(
				"Authentication role-state removal cancelled; no role state changed.",
			);
			return;
		}
	}

	await store.remove({ role, signal: options.signal });
	dependencies.report(`Removed role state for ${role}.`);
};

const runList = async (
	store: RoleStateStore,
	options: AuthOrchestratorOptions,
	dependencies: AuthOrchestratorDependencies,
	summaries?: readonly RoleStateSummary[],
): Promise<void> => {
	const entries =
		summaries ??
		(await runWithCommandSignal(() => store.list(), options.signal));
	for (const entry of entries) {
		dependencies.report(`${entry.role}\t${entry.status}`);
	}
};

export const orchestrateAuth = async (
	options: AuthOrchestratorOptions,
	dependencies: AuthOrchestratorDependencies,
): Promise<void> => {
	validateTerminalMode(options);
	const projectRoot = await runWithCommandSignal(
		() =>
			dependencies.loadEnvironment({
				cwd: options.cwd,
				environment: options.environment,
			}),
		options.signal,
	);
	throwIfCommandAborted(options.signal);
	const origin = configuredOrigin(options.environment);
	const config = await runWithCommandSignal(
		() =>
			dependencies.loadConfig({
				environment: options.environment,
				projectRoot,
			}),
		options.signal,
	);
	const liveOrigin = configuredOrigin(options.environment);
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

	let action: Exclude<AuthAction, "menu">;
	let summaries: readonly RoleStateSummary[] | undefined;
	let removalCandidates: readonly string[] | undefined;
	if (options.action === "menu") {
		summaries = await runWithCommandSignal(() => store.list(), options.signal);
		removalCandidates = await runWithCommandSignal(
			() => store.removableRoles(),
			options.signal,
		);
		const hasCapture = summaries.some(
			(summary) => summary.status === "missing",
		);
		const hasRefresh = summaries.some((summary) => summary.status === "ready");
		const hasRemoval = removalCandidates.length > 0;
		const selectedAction = await runWithCommandSignal(
			() =>
				dependencies.prompts.select({
					...createPromptContext(options),
					choices: [
						{
							disabled: hasCapture ? false : "No role is missing state",
							name: "Capture",
							value: "capture" as const,
						},
						{
							disabled: hasRefresh ? false : "No role has ready state",
							name: "Refresh",
							value: "refresh" as const,
						},
						{
							disabled: hasRemoval ? false : "No removable role state exists",
							name: "Remove",
							value: "remove" as const,
						},
						{ name: "List", value: "list" as const },
						{ name: "Cancel", value: "cancel" as const },
					],
					message: "Authentication role states",
				}),
			options.signal,
		);
		if (selectedAction === "cancel") {
			dependencies.report(
				"Authentication menu cancelled; no role state changed.",
			);
			return;
		}
		action = selectedAction;
	} else {
		action = options.action;
	}

	switch (action) {
		case "capture":
			await runCapture(config, store, origin, options, dependencies);
			return;
		case "refresh":
			await runRefresh(config, store, origin, options, dependencies);
			return;
		case "remove":
			await runRemove(store, options, dependencies, removalCandidates);
			return;
		case "list":
			await runList(store, options, dependencies, summaries);
			return;
		default: {
			const unsupportedAction: never = action;
			throw new ShopifyE2EInfrastructureError(
				"Authentication action could not be resolved",
				{ cause: unsupportedAction },
			);
		}
	}
};

export const defaultAuthDependencies = (
	prompts: PromptFunctions,
	report: (message: string) => void,
): AuthOrchestratorDependencies => ({
	captureRoleState: captureBrowserRoleState,
	createStore: createRoleStateStore,
	loadChromium: loadConsumerChromium,
	loadConfig: loadShopifyConfig,
	loadEnvironment,
	prompts,
	report,
	resolveDataRoot: resolveRoleStateDataRoot,
	resolvePeer: resolvePlaywrightPeer,
});
