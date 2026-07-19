import { Command, Errors, Flags } from "@oclif/core";

import { buildPlaywrightChildEnvironment } from "../config/execution-environment.cjs";
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
import { PACKAGE_ROOT } from "../package-root.js";
import {
	launchConsumerBrowserServer,
	type ManagedBrowserServer,
} from "../playwright/browser-server.js";
import {
	createPlaywrightExecutionContext,
	type PlaywrightExecutionContextArtifact,
} from "../playwright/execution-context.cjs";
import {
	type BuildPlaywrightInvocationOptions,
	buildPlaywrightInvocation,
	type PlaywrightInvocation,
} from "../playwright/invocation.js";
import type { ConsumerChromiumLauncher } from "../playwright/peer.js";
import {
	loadConsumerChromium,
	type ResolvedPlaywrightPeer,
	resolvePlaywrightPeer,
} from "../playwright/peer.js";
import {
	type RoleRunOutcome,
	runRolesSerially,
} from "../playwright/serial-role-runner.js";
import {
	CommandSignalError,
	commandSignalFromReason,
	createCommandSignalScope,
	runWithAbortSignal,
	runWithCommandSignal,
	throwIfAborted,
	throwIfCommandAborted,
} from "../process/command-signals.js";
import { runChild } from "../process/run-child.js";
import { inquirerPrompts } from "../prompts/inquirer.js";
import { normalizeConfiguredOrigin } from "../role-states/configured-origin.cjs";
import { resolveRoleStateDataRoot } from "../role-states/data-root.js";
import {
	assertConfiguredRole,
	configuredOriginForCommand,
	invalidStateForRole,
	missingState,
	unknownRole,
} from "../role-states/preflight.js";
import {
	createRoleStateStore,
	type RoleStateSelection,
	type RoleStateStatus,
	type RoleStateStore,
} from "../role-states/role-state-store.js";

export interface RunCommandOptions {
	readonly cwd: string;
	readonly dataDir?: string;
	readonly environment?: NodeJS.ProcessEnv;
	readonly grep?: string;
	readonly grepInvert?: string;
	readonly input?: NodeJS.ReadableStream;
	readonly interactive?: boolean;
	readonly output?: NodeJS.WritableStream;
	readonly packageRoot?: string;
	readonly role?: readonly string[];
	readonly signal?: AbortSignal;
}

interface SelectedShopifyBoundary {
	readonly configPath: string;
	readonly role: string;
	readonly testDir: string;
}

export interface RunCommandDependencies {
	readonly buildInvocation: (
		options: BuildPlaywrightInvocationOptions,
	) => PlaywrightInvocation;
	readonly createExecutionContext: (
		options: Parameters<typeof createPlaywrightExecutionContext>[0],
	) => Promise<PlaywrightExecutionContextArtifact>;
	readonly createStore: (options: {
		readonly dataRoot: string;
		readonly origin: string;
		readonly roles: readonly string[];
	}) => RoleStateStore;
	readonly loadEnvironment: (
		options: LoadEnvironmentOptions,
	) => Promise<string>;
	readonly loadConfig: (options: {
		readonly environment: NodeJS.ProcessEnv;
		readonly projectRoot: string;
	}) => Promise<LoadedShopifyConfig>;
	readonly launchBrowser: (options: {
		readonly chromium: ConsumerChromiumLauncher;
		readonly launchOptions: LoadedShopifyConfig["browserLaunchOptions"];
		readonly signal: AbortSignal;
	}) => Promise<ManagedBrowserServer>;
	readonly loadChromium: (
		peer: ResolvedPlaywrightPeer,
	) => Promise<ConsumerChromiumLauncher>;
	readonly reportSelection: (selection: SelectedShopifyBoundary) => void;
	readonly reportSummary: (outcomes: readonly RoleRunOutcome[]) => void;
	readonly resolveDataRoot: typeof resolveRoleStateDataRoot;
	readonly resolvePeer: (cwd: string) => Promise<ResolvedPlaywrightPeer>;
	readonly runChild: (
		invocation: PlaywrightInvocation,
		signal: AbortSignal,
	) => Promise<number>;
	readonly selectRoles: (options: {
		readonly choices: readonly {
			readonly name: string;
			readonly value: string;
		}[];
		readonly input?: NodeJS.ReadableStream;
		readonly output?: NodeJS.WritableStream;
		readonly signal: AbortSignal;
	}) => Promise<readonly string[]>;
}

const defaultDependencies: RunCommandDependencies = {
	buildInvocation: buildPlaywrightInvocation,
	createExecutionContext: createPlaywrightExecutionContext,
	createStore: createRoleStateStore,
	loadConfig: loadShopifyConfig,
	loadEnvironment,
	launchBrowser: launchConsumerBrowserServer,
	loadChromium: loadConsumerChromium,
	reportSelection: (selection) => {
		process.stderr.write(`Shopify config: ${selection.configPath}\n`);
		process.stderr.write(`Shopify test directory: ${selection.testDir}\n`);
		process.stderr.write(`Shopify role: ${selection.role}\n`);
	},
	reportSummary: (outcomes) => {
		process.stderr.write("Shopify role summary:\n");
		for (const outcome of outcomes) {
			const exit =
				outcome.exitCode === undefined ? "" : ` (exit ${outcome.exitCode})`;
			process.stderr.write(`  ${outcome.role}: ${outcome.status}${exit}\n`);
		}
	},
	resolveDataRoot: resolveRoleStateDataRoot,
	resolvePeer: resolvePlaywrightPeer,
	runChild: (invocation, signal) => runChild({ invocation, signal }),
	selectRoles: ({ choices, input, output, signal }) =>
		inquirerPrompts.checkbox({
			choices,
			input,
			message: "Which roles should run the Shopify tests?",
			output,
			required: true,
			signal,
		}),
};

const parseNonEmptyFilter = async (input: string): Promise<string> => {
	if (input.trim().length === 0) {
		throw new Errors.CLIError(
			"Playwright title filters must be non-empty strings",
		);
	}
	return input;
};

const throwForUnavailableState = async (
	store: RoleStateStore,
	role: string,
	signal: AbortSignal,
	status: RoleStateStatus | undefined,
): Promise<never> => {
	if (status === "missing") throw missingState(role);
	if (status === "invalid") {
		const removableRoles = await runWithCommandSignal(
			() => store.removableRoles(),
			signal,
		);
		throw invalidStateForRole(role, removableRoles);
	}
	throw unknownRole(role);
};

const resolveReadyRole = async (
	store: RoleStateStore,
	role: string,
	signal: AbortSignal,
	status: RoleStateStatus | undefined,
): Promise<RoleStateSelection> => {
	if (status !== "ready") {
		await throwForUnavailableState(store, role, signal, status);
	}
	try {
		return await runWithCommandSignal(() => store.resolve(role), signal);
	} catch (error) {
		if (error instanceof CommandSignalError) throw error;
		const latest = (
			await runWithCommandSignal(() => store.list(), signal)
		).find((candidate) => candidate.role === role);
		if (latest?.status !== "ready") {
			await throwForUnavailableState(store, role, signal, latest?.status);
		}
		throw error;
	}
};

interface ResolveRunSelectionArgs {
	readonly dependencies: RunCommandDependencies;
	readonly loadedConfig: LoadedShopifyConfig;
	readonly options: RunCommandOptions;
	readonly origin: string;
	readonly signal: AbortSignal;
}

const resolveRolesInConfigOrder = async (
	store: RoleStateStore,
	configuredRoles: readonly string[],
	selectedRoles: readonly string[],
	signal: AbortSignal,
	statuses: ReadonlyMap<string, RoleStateStatus>,
): Promise<readonly RoleStateSelection[]> => {
	const requestedRoles = new Set(selectedRoles);
	const selections: RoleStateSelection[] = [];
	for (const role of configuredRoles) {
		if (requestedRoles.has(role)) {
			selections.push(
				await resolveReadyRole(store, role, signal, statuses.get(role)),
			);
		}
	}
	return Object.freeze(selections);
};

const resolveRunSelection = async ({
	dependencies,
	loadedConfig,
	options,
	origin,
	signal,
}: ResolveRunSelectionArgs): Promise<readonly RoleStateSelection[]> => {
	throwIfCommandAborted(signal);
	if (
		(options.role === undefined || options.role.length === 0) &&
		!options.interactive
	) {
		throw new ShopifyE2EPreflightError(
			"A role is required in non-interactive use. Pass `--role <role>`.",
		);
	}
	const explicitRoles =
		options.role === undefined || options.role.length === 0
			? undefined
			: options.role.map((role) =>
					assertConfiguredRole(loadedConfig.roles, role),
				);
	const dataDir = options.dataDir;
	if (!dataDir) {
		throw new ShopifyE2EPreflightError(
			"Role-state data directory is unavailable",
		);
	}
	const dataRoot = await runWithCommandSignal(
		() =>
			dependencies.resolveDataRoot({
				dataDir,
				packageRoot: options.packageRoot ?? PACKAGE_ROOT,
				projectRoot: loadedConfig.projectRoot,
			}),
		signal,
	);
	const store = dependencies.createStore({
		dataRoot,
		origin,
		roles: loadedConfig.roles,
	});
	const summaries = await runWithCommandSignal(() => store.list(), signal);
	const statuses = new Map(
		summaries.map(({ role, status }) => [role, status] as const),
	);
	if (explicitRoles !== undefined) {
		return resolveRolesInConfigOrder(
			store,
			loadedConfig.roles,
			explicitRoles,
			signal,
			statuses,
		);
	}

	const readyRoles = loadedConfig.roles.filter(
		(role) => statuses.get(role) === "ready",
	);
	if (readyRoles.length === 0) {
		throw new ShopifyE2EPreflightError(
			"No configured role has ready state. Run `shopify-e2e auth capture --role <role>` for a missing role.",
		);
	}
	const selectedRoles = await runWithCommandSignal(
		() =>
			dependencies.selectRoles({
				choices: loadedConfig.roles
					.filter((role) => readyRoles.includes(role))
					.map((role) => ({ name: role, value: role })),
				input: options.input,
				output: options.output,
				signal,
			}),
		signal,
	);
	if (selectedRoles.length === 0) {
		throw new ShopifyE2EPreflightError("Select at least one role");
	}
	if (selectedRoles.some((role) => !readyRoles.includes(role))) {
		throw new ShopifyE2EPreflightError("Selected role is unavailable");
	}
	return resolveRolesInConfigOrder(
		store,
		loadedConfig.roles,
		selectedRoles,
		signal,
		statuses,
	);
};

const createExecutionContextWithSignal = async (
	dependencies: RunCommandDependencies,
	options: Parameters<typeof createPlaywrightExecutionContext>[0],
	signal: AbortSignal,
): Promise<PlaywrightExecutionContextArtifact> => {
	throwIfAborted(signal);
	const creation = dependencies.createExecutionContext(options);
	try {
		return await runWithAbortSignal(() => creation, signal);
	} catch (error) {
		if (signal.aborted) {
			let artifact: PlaywrightExecutionContextArtifact;
			try {
				artifact = await creation;
			} catch {
				throw error;
			}
			try {
				await artifact.cleanup();
			} catch {
				if (error instanceof CommandSignalError) {
					await retryExecutionContextCleanupAfterInterruption(artifact, error);
				}
				throw new ShopifyE2EInfrastructureError(
					"Temporary Playwright cleanup could not complete",
				);
			}
		}
		throw error;
	}
};

const retryExecutionContextCleanupAfterInterruption = async (
	artifact: PlaywrightExecutionContextArtifact,
	interruption: CommandSignalError,
): Promise<never> => {
	try {
		await artifact.cleanup();
	} catch {
		throw new CommandSignalError(
			interruption.signal,
			"Shopify test run interrupted; temporary Playwright cleanup could not complete.",
		);
	}
	throw interruption;
};

const assertConfiguredOriginUnchanged = (
	environment: NodeJS.ProcessEnv,
	expectedOrigin: string,
): void => {
	const configuredUrl = environment.SHOPIFY_STORE_URL;
	if (!configuredUrl) {
		throw new ShopifyE2EPreflightError(
			"SHOPIFY_STORE_URL was removed while trusted config was loading. Set it in the consumer .env file or inherited environment.",
		);
	}
	let currentOrigin: string;
	try {
		currentOrigin = normalizeConfiguredOrigin(configuredUrl);
	} catch (cause) {
		throw new ShopifyE2EPreflightError(
			"SHOPIFY_STORE_URL changed to an invalid value while trusted config was loading. Keep it stable in the consumer .env file or inherited environment.",
			{ cause },
		);
	}
	if (currentOrigin !== expectedOrigin) {
		throw new ShopifyE2EPreflightError(
			"SHOPIFY_STORE_URL changed while trusted config was loading. Keep it stable in the consumer .env file or inherited environment.",
		);
	}
};

export interface OrchestrateShopifyRunArgs {
	readonly dependencies?: RunCommandDependencies;
	readonly options: RunCommandOptions;
}

interface RunSelectedRoleArgs {
	readonly dependencies: RunCommandDependencies;
	readonly environment: NodeJS.ProcessEnv;
	readonly loadedConfig: LoadedShopifyConfig;
	readonly options: RunCommandOptions;
	readonly origin: string;
	readonly peer: ResolvedPlaywrightPeer;
	readonly selection: RoleStateSelection;
	readonly signal: AbortSignal;
	readonly wsEndpoint: string;
}

const runSelectedRole = async ({
	dependencies,
	environment,
	loadedConfig,
	options,
	origin,
	peer,
	selection,
	signal,
	wsEndpoint,
}: RunSelectedRoleArgs): Promise<number> => {
	const executionContext = await createExecutionContextWithSignal(
		dependencies,
		{
			configPath: loadedConfig.configPath,
			normalizedOrigin: origin,
			packageRoot: options.packageRoot ?? PACKAGE_ROOT,
			projectRoot: loadedConfig.projectRoot,
			role: selection.role,
			state: selection.state,
			testDir: loadedConfig.testDir,
		},
		signal,
	);

	let roleError: unknown;
	let exitCode: number | undefined;
	try {
		throwIfAborted(signal);
		const invocation = dependencies.buildInvocation({
			configPath: loadedConfig.configPath,
			controls: {
				...(options.grep === undefined ? {} : { grep: options.grep }),
				...(options.grepInvert === undefined
					? {}
					: { grepInvert: options.grepInvert }),
			},
			environment: buildPlaywrightChildEnvironment(
				environment,
				executionContext.contextPath,
				wsEndpoint,
			),
			peer,
		});
		throwIfAborted(signal);
		exitCode = await dependencies.runChild(invocation, signal);
	} catch (error) {
		roleError = error;
	}

	let cleanupError: unknown;
	try {
		await executionContext.cleanup();
	} catch (error) {
		cleanupError = error;
	}
	if (
		signal.aborted &&
		(signal.reason === "SIGINT" || signal.reason === "SIGTERM")
	) {
		const interruption = new CommandSignalError(
			commandSignalFromReason(signal.reason),
		);
		if (cleanupError !== undefined) {
			await retryExecutionContextCleanupAfterInterruption(
				executionContext,
				interruption,
			);
		}
		throw interruption;
	}
	if (cleanupError !== undefined) throw cleanupError;
	throwIfAborted(signal);
	if (roleError !== undefined) throw roleError;
	if (exitCode === undefined) {
		throw new ShopifyE2EInfrastructureError(
			"Playwright execution completed without an exit code",
		);
	}
	return exitCode;
};

export const orchestrateShopifyRun = async ({
	dependencies = defaultDependencies,
	options,
}: OrchestrateShopifyRunArgs): Promise<number> => {
	const environment = options.environment ?? process.env;
	const signal = options.signal ?? new AbortController().signal;
	const projectRoot = await runWithCommandSignal(
		() => dependencies.loadEnvironment({ cwd: options.cwd, environment }),
		signal,
	);
	throwIfCommandAborted(signal);
	const origin = configuredOriginForCommand(environment);
	const loadedConfig = await runWithCommandSignal(
		() => dependencies.loadConfig({ environment, projectRoot }),
		signal,
	);
	assertConfiguredOriginUnchanged(environment, origin);
	throwIfCommandAborted(signal);
	const selections = await resolveRunSelection({
		dependencies,
		loadedConfig,
		options,
		origin,
		signal,
	});
	const selection = selections[0];
	if (selection === undefined) {
		throw new ShopifyE2EPreflightError("Select at least one role");
	}
	const peer = await runWithCommandSignal(
		() => dependencies.resolvePeer(loadedConfig.projectRoot),
		signal,
	);
	throwIfCommandAborted(signal);
	const chromium = await runWithCommandSignal(
		() => dependencies.loadChromium(peer),
		signal,
	);
	throwIfCommandAborted(signal);
	const browser = await dependencies.launchBrowser({
		chromium,
		launchOptions: loadedConfig.browserLaunchOptions,
		signal,
	});

	let runError: unknown;
	let runExitCode: number | undefined;
	try {
		runExitCode = await runRolesSerially({
			browserUnexpectedClose: browser.unexpectedClose,
			reportActiveRole: (role) => {
				dependencies.reportSelection({
					configPath: loadedConfig.configPath,
					role,
					testDir: loadedConfig.testDir,
				});
			},
			reportSummary: dependencies.reportSummary,
			runRole: async (selectedRole, roleSignal) => {
				return runSelectedRole({
					dependencies,
					environment,
					loadedConfig,
					options,
					origin,
					peer,
					selection: selectedRole,
					signal: roleSignal,
					wsEndpoint: browser.wsEndpoint,
				});
			},
			selections,
			signal,
		});
	} catch (error) {
		runError = error;
	}
	let browserCleanupError: unknown;
	try {
		await browser.close();
	} catch (error) {
		browserCleanupError = error;
	}
	if (signal.aborted) {
		if (runError instanceof CommandSignalError) throw runError;
		throwIfCommandAborted(signal);
	}
	if (browserCleanupError !== undefined) throw browserCleanupError;
	if (runError !== undefined) throw runError;
	if (runExitCode === undefined) {
		throw new ShopifyE2EInfrastructureError(
			"Playwright execution completed without an exit code",
		);
	}
	return runExitCode;
};

export class Run extends Command {
	static override description =
		"Run one or more Shopify roles serially through one headed Chromium instance. Run controls are package-owned; arbitrary Playwright arguments are not accepted. Playwright workers, projects, file selectors, reporters, UI, and debug controls are intentionally unavailable.";

	static override flags = {
		grep: Flags.string({
			char: "g",
			description: "Run Shopify tests whose titles match this pattern",
			parse: parseNonEmptyFilter,
		}),
		"grep-invert": Flags.string({
			description: "Exclude Shopify tests whose titles match this pattern",
			parse: parseNonEmptyFilter,
		}),
		role: Flags.string({
			description:
				"Configured role to run (repeatable); omit in a terminal to select roles",
			multiple: true,
		}),
	};

	static override strict = true;

	public async run(): Promise<void> {
		const { flags } = await this.parse(Run);
		const signals = createCommandSignalScope();
		let exitCode: number;
		try {
			exitCode = await orchestrateShopifyRun({
				options: {
					cwd: process.cwd(),
					dataDir: this.config.dataDir,
					environment: process.env,
					grep: flags.grep,
					grepInvert: flags["grep-invert"],
					input: process.stdin,
					interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
					output: process.stdout,
					packageRoot: PACKAGE_ROOT,
					role: flags.role,
					signal: signals.signal,
				},
			});
		} catch (error) {
			if (error instanceof CommandSignalError) {
				this.error(error.message, { exit: error.exitCode });
			}
			if (
				error instanceof ShopifyE2EPreflightError ||
				error instanceof ShopifyE2EInfrastructureError
			) {
				this.error(error.message, { exit: error.exitCode });
			}
			if (
				error instanceof Error &&
				(error.name === "ExitPromptError" || error.name === "AbortPromptError")
			) {
				this.error("Role selection interrupted; no tests started.", {
					exit: 130,
				});
			}
			this.error("shopify-e2e could not complete Playwright execution", {
				exit: 1,
			});
		} finally {
			signals.dispose();
		}

		if (exitCode !== 0) this.exit(exitCode);
	}
}
