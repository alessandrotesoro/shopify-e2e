import { ShopifyE2EPreflightError } from "../errors.js";
import type { GeneratedPlaywrightConfig } from "./generated-config.js";
import type { ResolvedPlaywrightPeer } from "./peer.js";

export interface PlaywrightRunControls {
	readonly grep?: string;
	readonly grepInvert?: string;
}

export interface BuildPlaywrightInvocationOptions {
	readonly controls?: PlaywrightRunControls;
	readonly generatedConfig: GeneratedPlaywrightConfig;
	readonly peer: ResolvedPlaywrightPeer;
}

export interface PlaywrightInvocation {
	readonly args: readonly string[];
	readonly executable: string;
}

const CONTROL_FLAGS = {
	grep: "--grep",
	grepInvert: "--grep-invert",
} as const;

function translateControls(
	controls: PlaywrightRunControls | undefined,
): string[] {
	if (!controls) return [];

	const args: string[] = [];
	for (const key of Object.keys(controls)) {
		if (!(key in CONTROL_FLAGS)) {
			throw new ShopifyE2EPreflightError(
				`Unsupported Playwright run control: ${key}`,
			);
		}

		const control = key as keyof typeof CONTROL_FLAGS;
		const value = controls[control];
		if (typeof value !== "string" || value.trim().length === 0) {
			throw new ShopifyE2EPreflightError(
				`${CONTROL_FLAGS[control]} filter must be a non-empty string`,
			);
		}
		args.push(CONTROL_FLAGS[control], value);
	}
	return args;
}

export function buildPlaywrightInvocation(
	options: BuildPlaywrightInvocationOptions,
): PlaywrightInvocation {
	return {
		args: [
			options.peer.executablePath,
			"test",
			"--config",
			options.generatedConfig.configPath,
			"--workers=1",
			...translateControls(options.controls),
		],
		executable: process.execPath,
	};
}
