import { Command } from "@oclif/core";

import {
	type AuthAction,
	AuthMutationCommittedSignalError,
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

interface ExecuteAuthCommandArgs {
	readonly action: AuthAction;
	readonly command: Command;
	readonly role?: string;
	readonly yes?: boolean;
}

export interface AuthCommandFailure {
	readonly exitCode: 1 | 2 | 130 | 143;
	readonly message: string;
}

export interface ClassifyAuthCommandFailureArgs {
	error: unknown;
	signalExitCode?: 130 | 143;
}

export const classifyAuthCommandFailure = ({
	error,
	signalExitCode,
}: ClassifyAuthCommandFailureArgs): AuthCommandFailure => {
	if (error instanceof ShopifyE2EInfrastructureError) {
		return { exitCode: error.exitCode, message: error.message };
	}
	if (error instanceof AuthMutationCommittedSignalError) {
		return { exitCode: error.exitCode, message: error.message };
	}
	if (signalExitCode !== undefined || error instanceof CommandSignalError) {
		return {
			exitCode:
				signalExitCode ??
				(error instanceof CommandSignalError ? error.exitCode : 130),
			message: "Authentication interrupted; no role state changed.",
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
			message: "Authentication interrupted; no role state changed.",
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
	role,
	yes,
}: ExecuteAuthCommandArgs): Promise<void> => {
	const signals = createCommandSignalScope();
	try {
		await orchestrateAuth({
			options: {
				action,
				cwd: process.cwd(),
				dataDir: command.config.dataDir,
				environment: process.env,
				input: process.stdin,
				interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
				output: process.stdout,
				packageRoot: PACKAGE_ROOT,
				role,
				signal: signals.signal,
				yes,
			},
			dependencies: defaultAuthDependencies({
				prompts: inquirerPrompts,
				report: (message) => command.log(message),
			}),
		});
	} catch (error) {
		const failure = classifyAuthCommandFailure({
			error,
			signalExitCode: signals.exitCode(),
		});
		command.error(failure.message, { exit: failure.exitCode });
	} finally {
		signals.dispose();
	}
};

export class Auth extends Command {
	static override description =
		"Capture, refresh, remove, or inspect role-keyed browser authentication state. Credentials are entered only in the dedicated browser window.";

	static override examples = ["<%= config.bin %> <%= command.id %>"];

	static override strict = true;

	public async run(): Promise<void> {
		await this.parse(Auth);
		await executeAuthCommand({
			action: "menu",
			command: this,
		});
	}
}
