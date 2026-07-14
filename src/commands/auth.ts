import { Command, Flags } from "@oclif/core";

import {
	type AuthAction,
	defaultAuthDependencies,
	orchestrateAuth,
} from "../auth/auth-orchestrator.js";
import {
	ShopifyE2EInfrastructureError,
	ShopifyE2EPreflightError,
} from "../errors.js";
import { PACKAGE_ROOT } from "../package-root.js";
import {
	CommandSignalError,
	createCommandSignalScope,
} from "../process/command-signals.js";
import { inquirerPrompts } from "../prompts/inquirer.js";

export const configFlag = Flags.string({
	description:
		"Path to a dedicated Shopify configuration inside the consuming project",
});

interface ExecuteAuthCommandArgs {
	readonly action: AuthAction;
	readonly command: Command;
	readonly configPath?: string;
	readonly profile?: string;
	readonly role?: string;
}

export interface AuthCommandFailure {
	readonly exitCode: 1 | 2 | 130 | 143;
	readonly message: string;
}

export const classifyAuthCommandFailure = (
	error: unknown,
	signalExitCode?: 130 | 143,
): AuthCommandFailure => {
	if (error instanceof ShopifyE2EInfrastructureError) {
		return { exitCode: error.exitCode, message: error.message };
	}
	if (signalExitCode !== undefined || error instanceof CommandSignalError) {
		return {
			exitCode:
				signalExitCode ??
				(error instanceof CommandSignalError ? error.exitCode : 130),
			message: "Authentication interrupted; no profile changed.",
		};
	}
	if (error instanceof ShopifyE2EPreflightError) {
		return { exitCode: error.exitCode, message: error.message };
	}
	if (
		error instanceof Error &&
		(error.name === "ExitPromptError" || error.name === "AbortPromptError")
	) {
		return {
			exitCode: 130,
			message: "Authentication interrupted; no profile changed.",
		};
	}
	return {
		exitCode: 1,
		message: "shopify-e2e could not complete authentication",
	};
};

export const executeAuthCommand = async ({
	action,
	command,
	configPath,
	profile,
	role,
}: ExecuteAuthCommandArgs): Promise<void> => {
	const signals = createCommandSignalScope();
	try {
		await orchestrateAuth(
			{
				action,
				configPath,
				cwd: process.cwd(),
				dataDir: command.config.dataDir,
				environment: process.env,
				input: process.stdin,
				interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
				output: process.stdout,
				packageRoot: PACKAGE_ROOT,
				profile,
				role,
				signal: signals.signal,
			},
			defaultAuthDependencies(inquirerPrompts, (message) =>
				command.log(message),
			),
		);
	} catch (error) {
		const failure = classifyAuthCommandFailure(error, signals.exitCode());
		command.error(failure.message, { exit: failure.exitCode });
	} finally {
		signals.dispose();
	}
};

export class Auth extends Command {
	static override description =
		"Capture, refresh, or inspect browser authentication profiles. Credentials are entered only in the dedicated browser window.";

	static override examples = [
		"<%= config.bin %> <%= command.id %>",
		"<%= config.bin %> <%= command.id %> --config configs/shopify-e2e.config.ts",
	];

	static override flags = { config: configFlag };

	static override strict = true;

	public async run(): Promise<void> {
		const { flags } = await this.parse(Auth);
		await executeAuthCommand({
			action: "menu",
			command: this,
			configPath: flags.config,
		});
	}
}
