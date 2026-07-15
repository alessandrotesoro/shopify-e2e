import { Command, Errors, Flags } from "@oclif/core";

import {
	type LoadedShopifyConfig,
	loadRunnableShopifyConfig,
} from "../config/load-config.js";
import {
	type LoadEnvironmentOptions,
	loadEnvironment,
} from "../environment/load-environment.js";
import {
	ShopifyE2EInfrastructureError,
	ShopifyE2EPreflightError,
} from "../errors.js";
import { configFlag } from "../flags.js";
import { PACKAGE_ROOT } from "../package-root.js";
import {
	createGeneratedPlaywrightConfig,
	type GeneratedPlaywrightConfig,
} from "../playwright/generated-config.js";
import {
	type BuildPlaywrightInvocationOptions,
	buildPlaywrightInvocation,
	type PlaywrightInvocation,
} from "../playwright/invocation.js";
import {
	type ResolvedPlaywrightPeer,
	resolvePlaywrightPeer,
} from "../playwright/peer.js";
import {
	CommandSignalError,
	createCommandSignalScope,
	runWithCommandSignal,
	throwIfCommandAborted,
} from "../process/command-signals.js";
import { runChild } from "../process/run-child.js";
import {
	configuredOriginFromEnvironment,
	normalizeConfiguredOrigin,
	resolveProfileDataRoot,
} from "../profiles/configured-origin.js";
import {
	createProfileStore,
	EMPTY_STORAGE_STATE,
	type ProfileSelection,
	type ProfileStore,
} from "../profiles/profile-store.js";
import { inquirerPrompts } from "../prompts/inquirer.js";

export interface RunCommandOptions {
	readonly configPath?: string;
	readonly cwd: string;
	readonly dataDir?: string;
	readonly environment?: NodeJS.ProcessEnv;
	readonly grep?: string;
	readonly grepInvert?: string;
	readonly input?: NodeJS.ReadableStream;
	readonly interactive?: boolean;
	readonly output?: NodeJS.WritableStream;
	readonly packageRoot?: string;
	readonly profile?: string;
	readonly signal?: AbortSignal;
}

interface SelectedShopifyBoundary {
	readonly configPath: string;
	readonly profile: string;
	readonly role: string;
	readonly testDir: string;
}

export interface RunCommandDependencies {
	readonly buildInvocation: (
		options: BuildPlaywrightInvocationOptions,
	) => PlaywrightInvocation;
	readonly createGeneratedConfig: (
		options: Parameters<typeof createGeneratedPlaywrightConfig>[0],
	) => Promise<GeneratedPlaywrightConfig>;
	readonly createStore: (options: {
		readonly dataRoot: string;
		readonly origin: string;
		readonly roles: Parameters<typeof createProfileStore>[0]["roles"];
	}) => ProfileStore;
	readonly loadEnvironment: (
		options: LoadEnvironmentOptions,
	) => Promise<string>;
	readonly loadConfig: (options: {
		readonly configPath?: string;
		readonly projectRoot: string;
	}) => Promise<LoadedShopifyConfig>;
	readonly reportSelection: (selection: SelectedShopifyBoundary) => void;
	readonly resolveDataRoot: typeof resolveProfileDataRoot;
	readonly resolvePeer: (cwd: string) => Promise<ResolvedPlaywrightPeer>;
	readonly runChild: (invocation: PlaywrightInvocation) => Promise<number>;
	readonly selectProfile: (options: {
		readonly choices: readonly {
			readonly name: string;
			readonly value: string;
		}[];
		readonly input?: NodeJS.ReadableStream;
		readonly output?: NodeJS.WritableStream;
		readonly signal: AbortSignal;
	}) => Promise<string>;
}

const defaultDependencies: RunCommandDependencies = {
	buildInvocation: buildPlaywrightInvocation,
	createGeneratedConfig: createGeneratedPlaywrightConfig,
	createStore: createProfileStore,
	loadConfig: loadRunnableShopifyConfig,
	loadEnvironment,
	reportSelection: (selection) => {
		process.stderr.write(`Shopify config: ${selection.configPath}\n`);
		process.stderr.write(`Shopify test directory: ${selection.testDir}\n`);
		process.stderr.write(
			`Shopify profile: ${selection.profile} - ${selection.role}\n`,
		);
	},
	resolveDataRoot: resolveProfileDataRoot,
	resolvePeer: resolvePlaywrightPeer,
	runChild: (invocation) => runChild({ invocation }),
	selectProfile: ({ choices, input, output, signal }) =>
		inquirerPrompts.select({
			choices,
			input,
			message: "Which profile should run the Shopify tests?",
			output,
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

export interface OrchestrateShopifyRunArgs {
	readonly dependencies?: RunCommandDependencies;
	readonly options: RunCommandOptions;
}

interface ResolveRunSelectionArgs {
	readonly dependencies: RunCommandDependencies;
	readonly loadedConfig: Awaited<ReturnType<typeof loadRunnableShopifyConfig>>;
	readonly options: RunCommandOptions;
	readonly origin: string;
	readonly signal: AbortSignal;
}

const resolveRunSelection = async ({
	dependencies,
	loadedConfig,
	options,
	origin,
	signal,
}: ResolveRunSelectionArgs): Promise<ProfileSelection> => {
	throwIfCommandAborted(signal);
	if (
		options.profile !== undefined &&
		loadedConfig.roles[options.profile]?.authentication === "none"
	) {
		return {
			kind: "unauthenticated",
			name: options.profile,
			role: options.profile,
			state: EMPTY_STORAGE_STATE,
		};
	}
	const dataDir = options.dataDir;
	if (!dataDir) {
		throw new ShopifyE2EPreflightError("Profile data directory is unavailable");
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
	throwIfCommandAborted(signal);
	const store = dependencies.createStore({
		dataRoot,
		origin,
		roles: loadedConfig.roles,
	});
	const profile = options.profile;
	if (profile !== undefined) {
		return runWithCommandSignal(() => store.resolve(profile), signal);
	}
	if (!options.interactive) {
		throw new ShopifyE2EPreflightError(
			"A profile is required in non-interactive use. Pass `--profile <name>`.",
		);
	}
	const selections = await runWithCommandSignal(
		() => store.runnableProfiles(),
		signal,
	);
	if (selections.length === 0) {
		throw new ShopifyE2EPreflightError(
			"No runnable profile exists. Capture one or configure an unauthenticated role.",
		);
	}
	const selectionNames = new Set<string>();
	for (const selection of selections) {
		if (selectionNames.has(selection.name)) {
			throw new ShopifyE2EPreflightError(
				"A saved profile name collides with an unauthenticated role. Remove or rename the saved profile.",
			);
		}
		selectionNames.add(selection.name);
	}
	const selectedName = await runWithCommandSignal(
		() =>
			dependencies.selectProfile({
				choices: selections.map((candidate) => ({
					name:
						candidate.kind === "saved"
							? `${candidate.name} - ${candidate.role}`
							: `${candidate.role} - unauthenticated`,
					value: candidate.name,
				})),
				input: options.input,
				output: options.output,
				signal,
			}),
		signal,
	);
	const selected = selections.find(
		(candidate) => candidate.name === selectedName,
	);
	if (!selected) {
		throw new ShopifyE2EPreflightError("Selected profile is unavailable");
	}
	return runWithCommandSignal(() => store.resolve(selected.name), signal);
};

const createGeneratedConfigWithSignal = async (
	dependencies: RunCommandDependencies,
	options: Parameters<typeof createGeneratedPlaywrightConfig>[0],
	signal: AbortSignal,
): Promise<GeneratedPlaywrightConfig> => {
	throwIfCommandAborted(signal);
	const creation = dependencies.createGeneratedConfig(options);
	try {
		return await runWithCommandSignal(() => creation, signal);
	} catch (error) {
		if (error instanceof CommandSignalError) {
			let generatedConfig: GeneratedPlaywrightConfig;
			try {
				generatedConfig = await creation;
			} catch {
				// Creation failed after the signal won, so there is no config to clean.
				throw error;
			}
			try {
				await generatedConfig.cleanup();
			} catch {
				await retryGeneratedConfigCleanupAfterInterruption(
					generatedConfig,
					error,
				);
			}
		}
		throw error;
	}
};

const retryGeneratedConfigCleanupAfterInterruption = async (
	generatedConfig: GeneratedPlaywrightConfig,
	interruption: CommandSignalError,
): Promise<never> => {
	try {
		await generatedConfig.cleanup();
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
	const currentOrigin = normalizeConfiguredOrigin(configuredUrl);
	if (currentOrigin !== expectedOrigin) {
		throw new ShopifyE2EPreflightError(
			"SHOPIFY_STORE_URL changed while trusted config was loading. Keep it stable in the consumer .env file or inherited environment.",
		);
	}
};

export const orchestrateShopifyRun = async ({
	dependencies = defaultDependencies,
	options,
}: OrchestrateShopifyRunArgs): Promise<number> => {
	const environment = options.environment ?? process.env;
	const signal = options.signal ?? new AbortController().signal;
	const projectRoot = await runWithCommandSignal(
		() =>
			dependencies.loadEnvironment({
				cwd: options.cwd,
				environment,
			}),
		signal,
	);
	throwIfCommandAborted(signal);
	const origin = configuredOriginFromEnvironment(environment);
	const loadedConfig = await runWithCommandSignal(
		() =>
			dependencies.loadConfig({
				configPath: options.configPath,
				projectRoot,
			}),
		signal,
	);
	assertConfiguredOriginUnchanged(environment, origin);
	throwIfCommandAborted(signal);
	const selection = await runWithCommandSignal(
		() =>
			resolveRunSelection({
				dependencies,
				loadedConfig,
				options,
				origin,
				signal,
			}),
		signal,
	);
	const peer = await runWithCommandSignal(
		() => dependencies.resolvePeer(loadedConfig.projectRoot),
		signal,
	);
	throwIfCommandAborted(signal);
	const generatedConfig = await createGeneratedConfigWithSignal(
		dependencies,
		{
			packageRoot: options.packageRoot ?? PACKAGE_ROOT,
			projectRoot: loadedConfig.projectRoot,
			selection,
			testDir: loadedConfig.testDir,
		},
		signal,
	);

	let childError: unknown;
	let childExitCode: number | undefined;
	try {
		throwIfCommandAborted(signal);
		const invocation = dependencies.buildInvocation({
			controls: {
				...(options.grep === undefined ? {} : { grep: options.grep }),
				...(options.grepInvert === undefined
					? {}
					: { grepInvert: options.grepInvert }),
			},
			generatedConfig,
			peer,
		});
		throwIfCommandAborted(signal);
		dependencies.reportSelection({
			configPath: loadedConfig.configPath,
			profile: selection.name,
			role: selection.role,
			testDir: loadedConfig.testDir,
		});
		throwIfCommandAborted(signal);
		childExitCode = await dependencies.runChild(invocation);
	} catch (error) {
		childError = error;
	}
	let cleanupError: unknown;
	try {
		await generatedConfig.cleanup();
	} catch (error) {
		cleanupError = error;
	}
	if (cleanupError !== undefined && signal.aborted) {
		try {
			throwIfCommandAborted(signal);
		} catch (error) {
			if (error instanceof CommandSignalError) {
				await retryGeneratedConfigCleanupAfterInterruption(
					generatedConfig,
					error,
				);
			}
			throw error;
		}
	}
	throwIfCommandAborted(signal);
	if (cleanupError !== undefined) throw cleanupError;
	if (childError !== undefined) throw childError;
	if (childExitCode === undefined) {
		throw new ShopifyE2EInfrastructureError(
			"Playwright execution completed without an exit code",
		);
	}
	return childExitCode;
};

export class Run extends Command {
	static override description =
		"Run the dedicated Shopify Playwright E2E lane. Run controls are package-owned; arbitrary Playwright arguments are not accepted. Playwright workers, projects, file selectors, reporters, UI, and debug controls are intentionally unavailable.";

	static override flags = {
		config: configFlag,
		grep: Flags.string({
			char: "g",
			description: "Run Shopify tests whose titles match this pattern",
			parse: parseNonEmptyFilter,
		}),
		"grep-invert": Flags.string({
			description: "Exclude Shopify tests whose titles match this pattern",
			parse: parseNonEmptyFilter,
		}),
		profile: Flags.string({
			description:
				"Saved profile name or configured unauthenticated role to run",
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
					configPath: flags.config,
					cwd: process.cwd(),
					dataDir: this.config.dataDir,
					environment: process.env,
					grep: flags.grep,
					grepInvert: flags["grep-invert"],
					input: process.stdin,
					interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
					output: process.stdout,
					packageRoot: PACKAGE_ROOT,
					profile: flags.profile,
					signal: signals.signal,
				},
			});
		} catch (error) {
			if (error instanceof CommandSignalError) {
				this.error(error.message, {
					exit: error.exitCode,
				});
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
				this.error("Profile selection interrupted; no tests started.", {
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
