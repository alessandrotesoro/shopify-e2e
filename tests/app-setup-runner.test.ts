import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runAppSetupCommand } from "../src/app-setup-runner.js";
import type { ResolvedShopifyE2EConfig } from "../src/shopify-e2e-config.js";

const baseConfig: ResolvedShopifyE2EConfig = {
	authStatePath: "/tmp/auth.json",
	cdpPort: "9222",
	cdpUrl: "http://127.0.0.1:9222",
	chromeProfilePath: "/tmp/profile",
	cwd: "/tmp",
	live: true,
	shopDomain: "example.myshopify.com",
	testCommand: {
		args: ["playwright", "test"],
		command: "npx",
		mode: "playwright",
		shell: false,
	},
	testFiles: [],
};

describe("runAppSetupCommand", () => {
	it("runs a configured setup command with visible output and env-file values", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "shopify-e2e-app-setup-"));
		const envFile = join(cwd, ".env");
		const logs: string[] = [];

		await writeFile(envFile, "SHOPIFY_E2E_SETUP_VALUE=from-file\n");

		const code = await runAppSetupCommand(
			{
				...baseConfig,
				appSetupCommand: {
					args: [
						"-e",
						"process.exit(process.env.SHOPIFY_E2E_SETUP_VALUE === 'from-file' ? 0 : 7)",
					],
					command: process.execPath,
					mode: "custom",
					shell: false,
				},
				envFile,
			},
			{
				log: (message) => logs.push(message),
			},
		);

		expect(code).toBe(0);
		expect(logs).toEqual([
			expect.stringContaining("Running app setup command:"),
		]);
	});

	it("does nothing when no setup command is configured", async () => {
		await expect(runAppSetupCommand(baseConfig)).resolves.toBe(0);
	});
});
