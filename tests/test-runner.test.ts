import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ResolvedShopifyE2EConfig } from "../src/shopify-e2e-config.js";
import { buildTestCommand, runTestCommand } from "../src/test-runner.js";

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
	testFiles: ["e2e/live"],
};

describe("buildTestCommand", () => {
	it("forces one worker for default Playwright runner commands", () => {
		const command = buildTestCommand(baseConfig, ["--project=chromium"]);

		expect(command.command).toBe("npx");
		expect(command.args).toEqual([
			"playwright",
			"test",
			"e2e/live",
			"--project=chromium",
			"--workers=1",
		]);
		expect(command.forcedWorkers).toBe(true);
	});

	it("warns for shell commands it cannot enforce", () => {
		const command = buildTestCommand({
			...baseConfig,
			testCommand: {
				args: [],
				command: "bun run e2e",
				mode: "shell",
				shell: true,
			},
		});

		expect(command.forcedWorkers).toBe(false);
		expect(command.shell).toBe(true);
		expect(command.warnings[0]).toContain("cannot enforce");
	});

	it("returns the spawned test command exit code", async () => {
		const code = await runTestCommand({
			...baseConfig,
			testCommand: {
				args: ["-e", "process.exit(7)"],
				command: process.execPath,
				mode: "custom",
				shell: false,
			},
			testFiles: [],
		});

		expect(code).toBe(7);
	});

	it("marks CLI-launched runs so package global setup does not double-prepare Chrome", async () => {
		const code = await runTestCommand({
			...baseConfig,
			testCommand: {
				args: [
					"-e",
					"process.exit(process.env.SHOPIFY_E2E_SKIP_GLOBAL_SETUP === '1' ? 0 : 7)",
				],
				command: process.execPath,
				mode: "custom",
				shell: false,
			},
			testFiles: [],
		});

		expect(code).toBe(0);
	});

	it("loads env-file values for spawned test commands without overriding shell env", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "shopify-e2e-test-env-"));
		const envFile = join(cwd, ".env");
		const previousShellValue = process.env.SHOPIFY_E2E_SHELL_WINS;

		await writeFile(
			envFile,
			[
				"SHOPIFY_E2E_FILE_ONLY=file-value",
				"SHOPIFY_E2E_SHELL_WINS=file-value",
			].join("\n"),
		);

		process.env.SHOPIFY_E2E_SHELL_WINS = "shell-value";

		try {
			const code = await runTestCommand({
				...baseConfig,
				envFile,
				testCommand: {
					args: [
						"-e",
						[
							"const ok =",
							"process.env.SHOPIFY_E2E_FILE_ONLY === 'file-value'",
							"&& process.env.SHOPIFY_E2E_SHELL_WINS === 'shell-value'",
							"&& process.env.SHOPIFY_E2E_LIVE === '1';",
							"process.exit(ok ? 0 : 7);",
						].join(" "),
					],
					command: process.execPath,
					mode: "custom",
					shell: false,
				},
				testFiles: [],
			});

			expect(code).toBe(0);
		} finally {
			if (previousShellValue === undefined) {
				delete process.env.SHOPIFY_E2E_SHELL_WINS;
			} else {
				process.env.SHOPIFY_E2E_SHELL_WINS = previousShellValue;
			}
		}
	});
});
