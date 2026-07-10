import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ResolvedShopifyE2EConfig } from "../src/shopify-e2e-config.js";
import { buildTestCommand, runTestCommand } from "../src/test-runner.js";

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
	testFiles: ["e2e/live"],
};

describe("test runner", () => {
	it("always forces one Playwright worker", () => {
		expect(buildTestCommand(baseConfig, ["--project=chromium"])).toEqual({
			args: [
				"playwright",
				"test",
				"e2e/live",
				"--project=chromium",
				"--workers=1",
			],
			command: "npx",
			forcedWorkers: true,
			shell: false,
		});
	});

	it("applies selected profile and skip controls after inherited env", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "shopify-e2e-test-env-"));
		const envFile = join(cwd, ".env");
		const runnerFile = join(cwd, "runner.mjs");
		await writeFile(
			envFile,
			[
				"SHOPIFY_E2E_AUTH_PROFILE=from-file",
				"SHOPIFY_E2E_SKIP_GLOBAL_SETUP=0",
			].join("\n"),
		);
		await writeFile(
			runnerFile,
			[
				"const ok = process.env.SHOPIFY_E2E_AUTH_PROFILE === 'customer-a'",
				"&& process.env.SHOPIFY_E2E_SKIP_GLOBAL_SETUP === '1'",
				"&& process.argv.includes('--workers=1');",
				"process.exit(ok ? 0 : 7);",
			].join(" "),
		);
		const previousProfile = process.env.SHOPIFY_E2E_AUTH_PROFILE;
		const previousSkip = process.env.SHOPIFY_E2E_SKIP_GLOBAL_SETUP;
		process.env.SHOPIFY_E2E_AUTH_PROFILE = "from-process";
		process.env.SHOPIFY_E2E_SKIP_GLOBAL_SETUP = "0";

		try {
			const code = await runTestCommand({
				...baseConfig,
				envFile,
				testCommand: {
					args: [runnerFile],
					command: process.execPath,
				},
				testFiles: [],
			});

			expect(code).toBe(0);
		} finally {
			restoreEnv("SHOPIFY_E2E_AUTH_PROFILE", previousProfile);
			restoreEnv("SHOPIFY_E2E_SKIP_GLOBAL_SETUP", previousSkip);
		}
	});
});

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}

	process.env[name] = value;
}
