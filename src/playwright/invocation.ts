import { isAbsolute } from "node:path";

import { ShopifyE2EPreflightError } from "../errors.js";
import type { GeneratedPlaywrightConfig } from "./generated-config.js";
import type { ResolvedPlaywrightPeer } from "./peer.js";

export interface PlaywrightRunControls {
	readonly grep?: string;
	readonly grepInvert?: string;
}

export interface BuildPlaywrightInvocationOptions {
	readonly controls?: PlaywrightRunControls;
	readonly configPath?: string;
	/** Transitional input retained until U5 removes the generated config path. */
	readonly generatedConfig?: GeneratedPlaywrightConfig;
	readonly environment?: NodeJS.ProcessEnv;
	readonly peer: ResolvedPlaywrightPeer;
}

export interface PlaywrightInvocation {
	readonly args: readonly string[];
	readonly environment?: NodeJS.ProcessEnv;
	readonly executable: string;
}

const CONTROL_FLAGS = {
	grep: "--grep",
	grepInvert: "--grep-invert",
} as const;

const translateControls = (
	controls: PlaywrightRunControls | undefined,
): string[] => {
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
};

export const buildPlaywrightInvocation = (
	options: BuildPlaywrightInvocationOptions,
): PlaywrightInvocation => {
	if (
		(options.configPath === undefined) ===
		(options.generatedConfig === undefined)
	) {
		throw new ShopifyE2EPreflightError(
			"Playwright invocation requires exactly one package-owned config path",
		);
	}
	const configPath =
		options.configPath ?? options.generatedConfig?.configPath ?? "";
	if (!isAbsolute(configPath)) {
		throw new ShopifyE2EPreflightError(
			"Playwright invocation config path must be absolute",
		);
	}
	return {
		args: [
			options.peer.executablePath,
			"test",
			"--config",
			configPath,
			"--workers=1",
			...translateControls(options.controls),
		],
		...(options.environment === undefined
			? {}
			: { environment: options.environment }),
		executable: process.execPath,
	};
};
