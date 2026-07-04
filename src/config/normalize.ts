import type {
	ResolvedTestCommand,
	TestCommandInput,
} from "../shopify-e2e-config.js";
import { cleanString } from "./primitives.js";

export function normalizeTestCommand(
	input: TestCommandInput | undefined,
): ResolvedTestCommand {
	if (typeof input === "string") {
		return {
			args: [],
			command: input,
			mode: "shell",
			shell: true,
		};
	}

	return {
		args: normalizeStringArray(input?.args),
		command:
			cleanString(input?.command) ??
			(process.platform === "win32" ? "npx.cmd" : "npx"),
		mode: input?.mode ?? "playwright",
		shell: input?.shell ?? input?.mode === "shell",
	};
}

export function normalizeStringArray(value: string[] | undefined): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value.map((entry) => entry.trim()).filter(Boolean);
}
