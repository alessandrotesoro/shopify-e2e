import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");
const binPath = resolve(projectRoot, "bin/run.js");
const unrelatedCommandPath = resolve(projectRoot, "dist/commands/unrelated.js");
const importSentinelPath = resolve(projectRoot, "dist/unrelated-imported");
const temporaryDirectories: string[] = [];

function runCli(
	args: readonly string[],
	cwd = projectRoot,
	environmentOverrides: NodeJS.ProcessEnv = {},
) {
	return spawnSync(process.execPath, [binPath, ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...environmentOverrides, NO_COLOR: "1" },
	});
}

async function makeConsumerFixture(): Promise<string> {
	const consumer = await mkdtemp(join(tmpdir(), "shopify-e2e-cli-"));
	temporaryDirectories.push(consumer);
	const testDir = join(consumer, "shopify-tests");
	await mkdir(testDir);
	await writeFile(join(consumer, "package.json"), '{"type":"module"}\n');
	await writeFile(
		join(consumer, "shopify-e2e.config.ts"),
		'export default { testDir: "shopify-tests" };\n',
	);
	await writeFile(
		join(testDir, "checkout.spec.ts"),
		'import { test } from "@playwright/test";\ntest("shopify checkout", () => {});\n',
	);
	return consumer;
}

async function makeRunnableConsumer(): Promise<string> {
	const consumer = await makeConsumerFixture();
	await mkdir(join(consumer, "node_modules", "@playwright"), {
		recursive: true,
	});
	await symlink(
		join(projectRoot, "node_modules", "@playwright", "test"),
		join(consumer, "node_modules", "@playwright", "test"),
		"dir",
	);
	return consumer;
}

async function makeConsumerWithExitingPlaywright(
	exitCode: number,
): Promise<string> {
	const consumer = await makeConsumerFixture();
	const peerRoot = join(consumer, "node_modules", "@playwright", "test");
	await mkdir(peerRoot, { recursive: true });
	await writeFile(
		join(peerRoot, "package.json"),
		`${JSON.stringify(
			{
				bin: { playwright: "cli.js" },
				name: "@playwright/test",
				type: "module",
				version: "1.61.1",
			},
			null,
			2,
		)}\n`,
	);
	await writeFile(join(peerRoot, "cli.js"), `process.exit(${exitCode});\n`);
	return consumer;
}

describe.sequential("built CLI shell", () => {
	afterEach(async () => {
		await Promise.all([
			rm(unrelatedCommandPath, { force: true }),
			rm(importSentinelPath, { force: true }),
			...temporaryDirectories
				.splice(0)
				.map((directory) => rm(directory, { force: true, recursive: true })),
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
		expect(result.stdout).toContain("--config");
		expect(result.stdout).toContain("--grep");
		expect(result.stdout).toContain("-g");
		expect(result.stdout).toContain("--grep-invert");
		expect(result.stdout).toMatch(/workers.*unavailable/i);
		expect(result.stderr).toBe("");
	});

	it.each([
		["run", "ordinary.spec.ts"],
		["run", "--", "ordinary.spec.ts"],
		["run", "--workers", "2"],
		["run", "--project", "ordinary"],
		["run", "--reporter", "html"],
		["run", "--ui"],
	])("rejects unsupported run input before preflight: %s", (...args) => {
		const result = runCli(args);

		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(
			/unexpected argument|nonexistent flag|command .* not found/i,
		);
		expect(result.stderr).toMatch(/run|shopify-e2e/i);
	});

	it("runs a browserless Shopify spec and reports the selected boundary", async () => {
		const consumer = await makeRunnableConsumer();
		const result = runCli(["run"], consumer);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(/1 passed/i);
		expect(result.stderr).toContain("Shopify config:");
		expect(result.stderr).toContain("shopify-e2e.config.ts");
		expect(result.stderr).toContain("Shopify test directory:");
		expect(result.stderr).toContain("shopify-tests");
	});

	it("preserves Playwright's exit when an allowed filter selects no tests", async () => {
		const consumer = await makeRunnableConsumer();
		const result = runCli(["run", "--grep", "does not match"], consumer);

		expect(result.status).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/no tests found/i);
		expect(result.stderr).not.toMatch(/config.*invalid|preflight/i);
	});

	it("preserves a representative nonstandard Playwright child exit", async () => {
		const consumer = await makeConsumerWithExitingPlaywright(17);
		const result = runCli(["run"], consumer);

		expect(result.status, result.stderr).toBe(17);
		expect(result.stderr).toContain("Shopify config:");
		expect(result.stderr).toContain("Shopify test directory:");
	});

	it("reports package infrastructure failures as one safe generic error", async () => {
		const consumer = await makeRunnableConsumer();
		const missingTemporaryRoot = join(
			consumer,
			"missing-temporary-parent",
			"private-value",
		);
		const result = runCli(["run"], consumer, {
			TEMP: missingTemporaryRoot,
			TMP: missingTemporaryRoot,
			TMPDIR: missingTemporaryRoot,
		});

		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(
			/^\s*›?\s*Error: shopify-e2e could not complete Playwright execution\s*$/,
		);
		expect(result.stderr.match(/Error:/g)).toHaveLength(1);
		expect(result.stderr).not.toContain("private-value");
	});

	it("reports a missing dedicated config as preflight exit 2", async () => {
		const consumer = await mkdtemp(join(tmpdir(), "shopify-e2e-cli-"));
		temporaryDirectories.push(consumer);
		const result = runCli(["run"], consumer);

		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(/dedicated Shopify config.*does not exist/i);
		expect(result.stderr.match(/Error:/g)).toHaveLength(1);
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
