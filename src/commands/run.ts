import { Command, Flags } from "@oclif/core";

import { loadShopifyConfig } from "../config/load-config.js";
import {
	ShopifyE2EInfrastructureError,
	ShopifyE2EPreflightError,
} from "../errors.js";
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
import { runChild } from "../process/run-child.js";

export interface RunCommandOptions {
	readonly configPath?: string;
	readonly cwd: string;
	readonly grep?: string;
	readonly grepInvert?: string;
}

interface SelectedShopifyBoundary {
	readonly configPath: string;
	readonly testDir: string;
}

export interface RunCommandDependencies {
	readonly buildInvocation: (
		options: BuildPlaywrightInvocationOptions,
	) => PlaywrightInvocation;
	readonly createGeneratedConfig: (
		testDir: string,
	) => Promise<GeneratedPlaywrightConfig>;
	readonly reportSelection: (selection: SelectedShopifyBoundary) => void;
	readonly resolvePeer: (cwd: string) => Promise<ResolvedPlaywrightPeer>;
	readonly runChild: (invocation: PlaywrightInvocation) => Promise<number>;
}

const defaultDependencies: RunCommandDependencies = {
	buildInvocation: buildPlaywrightInvocation,
	createGeneratedConfig: createGeneratedPlaywrightConfig,
	reportSelection(selection) {
		process.stderr.write(`Shopify config: ${selection.configPath}\n`);
		process.stderr.write(`Shopify test directory: ${selection.testDir}\n`);
	},
	resolvePeer: resolvePlaywrightPeer,
	runChild,
};

export async function orchestrateShopifyRun(
	options: RunCommandOptions,
	dependencies: RunCommandDependencies = defaultDependencies,
): Promise<number> {
	const loadedConfig = await loadShopifyConfig({
		configPath: options.configPath,
		cwd: options.cwd,
	});
	const peer = await dependencies.resolvePeer(loadedConfig.projectRoot);
	const generatedConfig = await dependencies.createGeneratedConfig(
		loadedConfig.testDir,
	);

	try {
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
		dependencies.reportSelection({
			configPath: loadedConfig.configPath,
			testDir: loadedConfig.testDir,
		});
		return await dependencies.runChild(invocation);
	} finally {
		await generatedConfig.cleanup();
	}
}

export default class Run extends Command {
	static override description =
		"Run the dedicated Shopify Playwright E2E lane. Run controls are package-owned; arbitrary Playwright arguments are not accepted. Playwright workers, projects, file selectors, reporters, UI, and debug controls are intentionally unavailable.";

	static override flags = {
		config: Flags.string({
			description:
				"Path to a dedicated Shopify configuration inside the consuming project",
		}),
		grep: Flags.string({
			char: "g",
			description: "Run Shopify tests whose titles match this pattern",
		}),
		"grep-invert": Flags.string({
			description: "Exclude Shopify tests whose titles match this pattern",
		}),
	};

	static override strict = true;

	public async run(): Promise<void> {
		const { flags } = await this.parse(Run);
		let exitCode: number;
		try {
			exitCode = await orchestrateShopifyRun({
				configPath: flags.config,
				cwd: process.cwd(),
				grep: flags.grep,
				grepInvert: flags["grep-invert"],
			});
		} catch (error) {
			if (
				error instanceof ShopifyE2EPreflightError ||
				error instanceof ShopifyE2EInfrastructureError
			) {
				this.error(error.message, { exit: error.exitCode });
			}
			this.error("shopify-e2e could not complete Playwright execution", {
				exit: 1,
			});
		}

		if (exitCode !== 0) this.exit(exitCode);
	}
}
