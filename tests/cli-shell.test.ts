import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");
const binPath = resolve(projectRoot, "bin/run.js");
const unrelatedCommandPath = resolve(projectRoot, "dist/commands/unrelated.js");
const importSentinelPath = resolve(projectRoot, "dist/unrelated-imported");

function runCli(args: readonly string[]) {
	return spawnSync(process.execPath, [binPath, ...args], {
		cwd: projectRoot,
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1" },
	});
}

describe.sequential("built CLI shell", () => {
	afterEach(async () => {
		await Promise.all([
			rm(unrelatedCommandPath, { force: true }),
			rm(importSentinelPath, { force: true }),
		]);
	});

	it.each([{ args: [] }, { args: ["--help"] }])("prints root help for $args", ({
		args,
	}) => {
		const result = runCli(args);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("USAGE");
		expect(result.stdout).toContain("COMMANDS");
		expect(result.stdout).toMatch(/\brun\b/);
		expect(result.stderr).toBe("");
	});

	it("prints run command help", () => {
		const result = runCli(["run", "--help"]);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("USAGE");
		expect(result.stdout).toContain("shopify-e2e run");
		expect(result.stdout).toContain(
			"arbitrary Playwright arguments are not accepted",
		);
		expect(result.stderr).toBe("");
	});

	it("prints package version metadata", async () => {
		const packageJson = JSON.parse(
			await (await import("node:fs/promises")).readFile(
				resolve(projectRoot, "package.json"),
				"utf8",
			),
		) as { name: string; version: string };
		const result = runCli(["--version"]);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain(packageJson.name);
		expect(result.stdout).toContain(packageJson.version);
		expect(result.stderr).toBe("");
	});

	it("rejects unknown commands without scanning unrelated compiled files", async () => {
		await mkdir(resolve(projectRoot, "dist/commands"), { recursive: true });
		await writeFile(
			unrelatedCommandPath,
			`import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(importSentinelPath)}, 'imported');\n`,
		);

		const result = runCli(["unrelated"]);

		expect(result.status).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(
			/command unrelated not found/i,
		);
		expect(existsSync(importSentinelPath)).toBe(false);
	});
});
