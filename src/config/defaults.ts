import { resolve } from "node:path";

import type { CommandMode, ShopifyE2EConfig } from "../shopify-e2e-config.js";

export const defaultConfigFiles = [
	"shopify-e2e.config.mjs",
	"shopify-e2e.config.js",
	"shopify-e2e.config.cjs",
	"shopify-e2e.config.json",
] as const;

export const defaultCdpPort = "9222";

export const commandModes = [
	"playwright",
	"custom",
	"shell",
] as const satisfies readonly CommandMode[];

export function defaultConfig(cwd: string): ShopifyE2EConfig {
	return {
		authStatePath: resolve(
			cwd,
			".shopify-e2e/auth/shopify-storage-state.json",
		),
		chromeProfilePath: resolve(cwd, ".shopify-e2e/chrome-profile"),
		live: false,
		testCommand: {
			args: ["playwright", "test"],
			command: process.platform === "win32" ? "npx.cmd" : "npx",
			mode: "playwright",
		},
		testFiles: [],
	};
}
