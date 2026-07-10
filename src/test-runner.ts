import { spawn } from "node:child_process";

import { inheritedCommandEnvironment } from "./app-setup-runner.js";
import type { ResolvedShopifyE2EConfig } from "./shopify-e2e-config.js";

export interface BuiltTestCommand {
	args: string[];
	command: string;
	forcedWorkers: boolean;
	shell: boolean;
}

export function buildTestCommand(
	config: ResolvedShopifyE2EConfig,
	passThroughArgs: string[] = [],
): BuiltTestCommand {
	const base = config.testCommand;

	return {
		args: [
			...base.args,
			...config.testFiles,
			...passThroughArgs,
			"--workers=1",
		],
		command: base.command,
		forcedWorkers: true,
		shell: false,
	};
}

export async function runTestCommand(
	config: ResolvedShopifyE2EConfig,
	passThroughArgs: string[] = [],
): Promise<number> {
	const command = buildTestCommand(config, passThroughArgs);

	const child = spawn(command.command, command.args, {
		env: testCommandEnvironment(config),
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

export function testCommandEnvironment(
	config: Pick<ResolvedShopifyE2EConfig, "authProfile" | "envFile">,
): NodeJS.ProcessEnv {
	return {
		...inheritedCommandEnvironment(config),
		SHOPIFY_E2E_AUTH_PROFILE: config.authProfile.name,
		SHOPIFY_E2E_SKIP_GLOBAL_SETUP: "1",
	};
}
