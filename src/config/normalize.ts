import type {
	CommandInput,
	ResolvedCommand,
	ResolvedTestCommand,
	TestCommandInput,
} from "../shopify-e2e-config.js";
import { cleanString } from "./primitives.js";

export function normalizeOptionalCommand(
	input: CommandInput | undefined,
): ResolvedCommand | undefined {
	if (input === undefined) {
		return undefined;
	}

	return normalizeCommand(input);
}

export function normalizeTestCommand(
	input: TestCommandInput | undefined,
): ResolvedTestCommand {
	return {
		args: normalizeStringArray(
			input?.args ?? (input ? [] : ["playwright", "test"]),
		),
		command:
			cleanString(input?.command) ??
			(process.platform === "win32" ? "npx.cmd" : "npx"),
	};
}

function normalizeCommand(
	input: CommandInput | undefined,
	defaults: Partial<ResolvedCommand> = {},
): ResolvedCommand {
	if (typeof input === "string") {
		return {
			args: [],
			command: input,
			mode: "shell",
			shell: true,
		};
	}

	const command = cleanString(input?.command) ?? defaults.command;

	if (!command) {
		throw new Error("Shopify E2E command object requires a command.");
	}

	return {
		args: normalizeStringArray(input?.args),
		command,
		mode: input?.mode ?? defaults.mode ?? "custom",
		shell: input?.shell ?? input?.mode === "shell",
	};
}

export function normalizeStringArray(value: string[] | undefined): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.map((entry) => entry.trim()).filter(Boolean);
}
