import { spawn } from "node:child_process";

import { parseEnvFile } from "./config/env.js";
import type {
	ResolvedCommand,
	ResolvedShopifyE2EConfig,
} from "./shopify-e2e-config.js";

interface RunAppSetupCommandOptions {
	log?: (message: string) => void;
}

export async function runAppSetupCommand(
	config: ResolvedShopifyE2EConfig,
	options: RunAppSetupCommandOptions = {},
): Promise<number> {
	if (!config.appSetupCommand) {
		return 0;
	}

	options.log?.(
		`Running app setup command: ${formatCommand(config.appSetupCommand)}`,
	);

	return runCommand(config.appSetupCommand, {
		env: commandEnvironment(config),
	});
}

export function commandEnvironment(
	config: Pick<ResolvedShopifyE2EConfig, "envFile">,
): NodeJS.ProcessEnv {
	const envFile = config.envFile ? parseEnvFile(config.envFile) : {};

	return {
		...envFile,
		...process.env,
		SHOPIFY_E2E_LIVE: "1",
		SHOPIFY_E2E_SKIP_GLOBAL_SETUP: "1",
	};
}

function runCommand(
	command: ResolvedCommand,
	options: { env: NodeJS.ProcessEnv },
): Promise<number> {
	const child = spawn(command.command, command.args, {
		env: options.env,
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
					`App setup command exited from signal ${signal ?? "unknown"}.`,
				),
			);
		});
	});
}

function formatCommand(command: ResolvedCommand): string {
	return [command.command, ...command.args].join(" ");
}
