import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runAppSetupCommand } from "../src/app-setup-runner.js";
import type { ResolvedShopifyE2EConfig } from "../src/shopify-e2e-config.js";

const baseConfig: ResolvedShopifyE2EConfig = {
	authProfile: {
		name: "customer-a",
		storageStatePath: "/tmp/.shopify-e2e/auth/profiles/customer-a.json",
	},
	cdpPort: "9222",
	cdpUrl: "http://127.0.0.1:9222",
	chromeProfilePath: "/tmp/chrome",
	cwd: "/tmp",
	live: true,
	shopDomain: "example.myshopify.com",
	testCommand: { args: ["playwright", "test"], command: "npx" },
	testFiles: [],
};

describe("runAppSetupCommand", () => {
	it("runs custom app setup without package-owned profile controls", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "shopify-e2e-app-setup-"));
		const envFile = join(cwd, ".env");

		await writeFile(
			envFile,
			[
				"SHOPIFY_E2E_SETUP_VALUE=from-file",
				"SHOPIFY_E2E_AUTH_PROFILE=from-file",
				"SHOPIFY_E2E_SKIP_GLOBAL_SETUP=from-file",
			].join("\n"),
		);

		const previousProfile = process.env.SHOPIFY_E2E_AUTH_PROFILE;
		const previousSkip = process.env.SHOPIFY_E2E_SKIP_GLOBAL_SETUP;
		process.env.SHOPIFY_E2E_AUTH_PROFILE = "from-process";
		process.env.SHOPIFY_E2E_SKIP_GLOBAL_SETUP = "from-process";

		try {
			const code = await runAppSetupCommand({
				...baseConfig,
				appSetupCommand: {
					args: [
						"-e",
						[
							"const ok = process.env.SHOPIFY_E2E_SETUP_VALUE === 'from-file'",
							"&& process.env.SHOPIFY_E2E_LIVE === '1'",
							"&& process.env.SHOPIFY_E2E_AUTH_PROFILE === undefined",
							"&& process.env.SHOPIFY_E2E_SKIP_GLOBAL_SETUP === undefined;",
							"process.exit(ok ? 0 : 7);",
						].join(" "),
					],
					command: process.execPath,
					mode: "custom",
					shell: false,
				},
				envFile,
			});

			expect(code).toBe(0);
		} finally {
			restoreEnv("SHOPIFY_E2E_AUTH_PROFILE", previousProfile);
			restoreEnv("SHOPIFY_E2E_SKIP_GLOBAL_SETUP", previousSkip);
		}
	});

	it("does nothing when no setup command is configured", async () => {
		await expect(runAppSetupCommand(baseConfig)).resolves.toBe(0);
	});
});

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}

	process.env[name] = value;
}
