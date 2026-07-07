import { spawn } from "node:child_process";

import type { ResolvedShopifyE2EConfig } from "./shopify-e2e-config.js";

export interface BuiltTestCommand {
	args: string[];
	command: string;
	forcedWorkers: boolean;
	shell: boolean;
	warnings: string[];
}

export function buildTestCommand(
	config: ResolvedShopifyE2EConfig,
	passThroughArgs: string[] = [],
): BuiltTestCommand {
	const base = config.testCommand;
	const warnings: string[] = [];

	if (base.mode === "shell") {
		warnings.push(
			"Custom shell test command configured; shopify-e2e cannot enforce Playwright --workers=1 inside that command.",
		);

		return {
			args: [...config.testFiles, ...passThroughArgs],
			command: base.command,
			forcedWorkers: false,
			shell: true,
			warnings,
		};
	}

	const forcedWorkers = base.mode === "playwright";
	const workerArgs = forcedWorkers ? ["--workers=1"] : [];

	if (!forcedWorkers) {
		warnings.push(
			"Custom test command mode configured; ensure live Shopify tests run with one worker.",
		);
	}

	return {
		args: [
			...base.args,
			...config.testFiles,
			...passThroughArgs,
			...workerArgs,
		],
		command: base.command,
		forcedWorkers,
		shell: base.shell,
		warnings,
	};
}

export async function runTestCommand(
	config: ResolvedShopifyE2EConfig,
	passThroughArgs: string[] = [],
): Promise<number> {
	const command = buildTestCommand(config, passThroughArgs);

	for (const warning of command.warnings) {
		process.stderr.write(`${warning}\n`);
	}

	const child = spawn(command.command, command.args, {
		env: {
			...process.env,
			SHOPIFY_E2E_LIVE: "1",
			SHOPIFY_E2E_SKIP_GLOBAL_SETUP: "1",
		},
		shell: command.shell,
		stdio: "inherit",
	});

	return new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (typeof code === "number") {
				resolve(code);
				return;
			}

			reject(
				new Error(
					`Test command exited from signal ${signal ?? "unknown"}.`,
				),
			);
		});
	});
}
