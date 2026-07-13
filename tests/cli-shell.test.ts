import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");
const binPath = resolve(projectRoot, "bin/run.js");
const unrelatedCommandPath = resolve(projectRoot, "dist/commands/unrelated.js");
const importSentinelPath = resolve(projectRoot, "dist/unrelated-imported");
const temporaryDirectories: string[] = [];
const dotenvOutputPattern =
	/injected env|failed to load|no encoding is specified/i;

interface RunCliArgs {
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly environmentOverrides?: NodeJS.ProcessEnv;
}

const runCli = ({
	args,
	cwd = projectRoot,
	environmentOverrides = {},
}: RunCliArgs) => {
	return spawnSync(process.execPath, [binPath, ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...environmentOverrides, NO_COLOR: "1" },
	});
};

const makeConsumerFixture = async (consumerRoot?: string): Promise<string> => {
	const consumer =
		consumerRoot ?? (await mkdtemp(join(tmpdir(), "shopify-e2e-cli-")));
	if (consumerRoot === undefined) temporaryDirectories.push(consumer);
	else await mkdir(consumer, { recursive: true });
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
};

const makeRunnableConsumer = async (consumerRoot?: string): Promise<string> => {
	const consumer = await makeConsumerFixture(consumerRoot);
	await mkdir(join(consumer, "node_modules", "@playwright"), {
		recursive: true,
	});
	await symlink(
		join(projectRoot, "node_modules", "@playwright", "test"),
		join(consumer, "node_modules", "@playwright", "test"),
		"dir",
	);
	return consumer;
};

const makeDotenvAwareConsumer = async (): Promise<string> => {
	const consumer = await makeRunnableConsumer();
	await writeFile(
		join(consumer, "shopify-e2e.config.ts"),
		`const isExpected = process.env.SHOPIFY_E2E_DOTENV_SENTINEL === process.env.SHOPIFY_E2E_DOTENV_EXPECTED && process.env.DOTENV_CONFIG_DEBUG === process.env.SHOPIFY_E2E_DOTENV_EXPECTED_DEBUG && process.env.DOTENV_CONFIG_QUIET === process.env.SHOPIFY_E2E_DOTENV_EXPECTED_QUIET; export default { testDir: isExpected ? "shopify-tests" : "missing-tests" };\n`,
	);
	await writeFile(
		join(consumer, "shopify-tests", "checkout.spec.ts"),
		'import { expect, test } from "@playwright/test";\ntest("dotenv reaches Playwright", () => { expect(process.env.SHOPIFY_E2E_DOTENV_SENTINEL).toBe(process.env.SHOPIFY_E2E_DOTENV_EXPECTED); expect(process.env.DOTENV_CONFIG_DEBUG).toBe(process.env.SHOPIFY_E2E_DOTENV_EXPECTED_DEBUG); expect(process.env.DOTENV_CONFIG_QUIET).toBe(process.env.SHOPIFY_E2E_DOTENV_EXPECTED_QUIET); });\n',
	);
	return consumer;
};

const makeConsumerWithExitingPlaywright = async (
	exitCode: number,
): Promise<string> => {
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
};

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
		const result = runCli({ args });

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("USAGE");
		expect(result.stdout).toContain("COMMANDS");
		expect(result.stdout).toMatch(/\brun\b/);
		expect(result.stderr).toBe("");
	});

	it("prints run command help", () => {
		const result = runCli({ args: ["run", "--help"] });

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
		const result = runCli({ args });

		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(
			/unexpected argument|nonexistent flag|command .* not found/i,
		);
		expect(result.stderr).toMatch(/run|shopify-e2e/i);
	});

	it("runs a browserless Shopify spec and reports the selected boundary", async () => {
		const consumer = await makeRunnableConsumer();
		const result = runCli({ args: ["run"], cwd: consumer });

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(/1 passed/i);
		expect(result.stderr).toContain("Shopify config:");
		expect(result.stderr).toContain("shopify-e2e.config.ts");
		expect(result.stderr).toContain("Shopify test directory:");
		expect(result.stderr).toContain("shopify-tests");
	});

	it("loads cwd .env before config and exposes the same value to Playwright", async () => {
		const consumer = await makeDotenvAwareConsumer();
		await writeFile(
			join(consumer, ".env"),
			"SHOPIFY_E2E_DOTENV_SENTINEL=from-consumer-dotenv\nDOTENV_CONFIG_DEBUG=1\nDOTENV_CONFIG_QUIET=false\n",
		);
		const result = runCli({
			args: ["run"],
			cwd: consumer,
			environmentOverrides: {
				DOTENV_CONFIG_DEBUG: undefined,
				DOTENV_CONFIG_QUIET: undefined,
				SHOPIFY_E2E_DOTENV_EXPECTED: "from-consumer-dotenv",
				SHOPIFY_E2E_DOTENV_EXPECTED_DEBUG: "1",
				SHOPIFY_E2E_DOTENV_EXPECTED_QUIET: "false",
				SHOPIFY_E2E_DOTENV_SENTINEL: undefined,
			},
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(/1 passed/i);
		expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
			dotenvOutputPattern,
		);
	});

	it.each([
		{ label: "non-empty", value: "from-shell" },
		{ label: "empty", value: "" },
	])("preserves a $label inherited value over .env", async ({ value }) => {
		const consumer = await makeDotenvAwareConsumer();
		await writeFile(
			join(consumer, ".env"),
			"SHOPIFY_E2E_DOTENV_SENTINEL=from-consumer-dotenv\n",
		);
		const result = runCli({
			args: ["run"],
			cwd: consumer,
			environmentOverrides: {
				DOTENV_CONFIG_DEBUG: undefined,
				DOTENV_CONFIG_QUIET: undefined,
				SHOPIFY_E2E_DOTENV_EXPECTED: value,
				SHOPIFY_E2E_DOTENV_EXPECTED_DEBUG: undefined,
				SHOPIFY_E2E_DOTENV_EXPECTED_QUIET: undefined,
				SHOPIFY_E2E_DOTENV_SENTINEL: value,
			},
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(/1 passed/i);
	});

	it("reports an unreadable .env as one sanitized preflight error before config", async () => {
		const consumer = await makeRunnableConsumer();
		const configMarker = join(consumer, "private-config-marker");
		await mkdir(join(consumer, ".env"));
		await writeFile(
			join(consumer, "shopify-e2e.config.ts"),
			`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(configMarker)}, "loaded"); export default { testDir: "shopify-tests" };\n`,
		);
		const result = runCli({
			args: ["run"],
			cwd: consumer,
			environmentOverrides: {
				DOTENV_CONFIG_DEBUG: "1",
				DOTENV_CONFIG_QUIET: "false",
			},
		});

		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(/consumer \.env could not be read/i);
		expect(result.stderr.match(/Error:/g)).toHaveLength(1);
		expect(result.stderr).not.toContain(configMarker);
		expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
			dotenvOutputPattern,
		);
		expect(existsSync(configMarker)).toBe(false);
	});

	it.each([
		{ args: ["--help"], status: 0 },
		{ args: ["run", "--help"], status: 0 },
		{ args: ["--version"], status: 0 },
		{ args: ["unknown"], status: 2 },
		{ args: ["run", "ordinary.spec.ts"], status: 2 },
		{ args: ["run", "--workers", "2"], status: 2 },
	])("does not load .env for rejected or informational input: $args", async ({
		args,
		status,
	}) => {
		const consumer = await makeConsumerFixture();
		await mkdir(join(consumer, ".env"));
		const result = runCli({ args, cwd: consumer });

		expect(result.status).toBe(status);
		expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
			/consumer \.env could not be read/i,
		);
	});

	it("keeps dotenv discovery at the invocation root with nested --config", async () => {
		const parent = await mkdtemp(join(tmpdir(), "shopify-e2e-cli-parent-"));
		temporaryDirectories.push(parent);
		await writeFile(
			join(parent, ".env"),
			"SHOPIFY_E2E_DOTENV_SENTINEL=parent-directory\n",
		);
		const consumer = await makeRunnableConsumer(join(parent, "consumer"));
		const nested = join(consumer, "nested");
		const nestedTests = join(nested, "shopify-tests");
		await mkdir(nestedTests, { recursive: true });
		await writeFile(
			join(consumer, ".env"),
			"SHOPIFY_E2E_DOTENV_SENTINEL=invocation-root\n",
		);
		await writeFile(
			join(consumer, ".env.local"),
			"SHOPIFY_E2E_DOTENV_SENTINEL=local-variant\n",
		);
		await writeFile(
			join(nested, ".env"),
			"SHOPIFY_E2E_DOTENV_SENTINEL=config-sibling\n",
		);
		await writeFile(
			join(nested, "shopify-e2e.config.ts"),
			`export default { testDir: process.env.SHOPIFY_E2E_DOTENV_SENTINEL === "invocation-root" ? "shopify-tests" : "missing-tests" };\n`,
		);
		await writeFile(
			join(nestedTests, "dotenv.spec.ts"),
			'import { expect, test } from "@playwright/test"; test("root-only dotenv", () => { expect(process.env.SHOPIFY_E2E_DOTENV_SENTINEL).toBe("invocation-root"); });\n',
		);
		const result = runCli({
			args: ["run", "--config", "nested/shopify-e2e.config.ts"],
			cwd: consumer,
			environmentOverrides: { SHOPIFY_E2E_DOTENV_SENTINEL: undefined },
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(/1 passed/i);
	});

	it("preserves Playwright's exit when an allowed filter selects no tests", async () => {
		const consumer = await makeRunnableConsumer();
		const result = runCli({
			args: ["run", "--grep", "does not match"],
			cwd: consumer,
		});

		expect(result.status).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/no tests found/i);
		expect(result.stderr).not.toMatch(/config.*invalid|preflight/i);
	});

	it("preserves a representative nonstandard Playwright child exit", async () => {
		const consumer = await makeConsumerWithExitingPlaywright(17);
		const result = runCli({ args: ["run"], cwd: consumer });

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
		const result = runCli({
			args: ["run"],
			cwd: consumer,
			environmentOverrides: {
				TEMP: missingTemporaryRoot,
				TMP: missingTemporaryRoot,
				TMPDIR: missingTemporaryRoot,
			},
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
		const result = runCli({ args: ["run"], cwd: consumer });

		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(/dedicated Shopify config.*does not exist/i);
		expect(result.stderr.match(/Error:/g)).toHaveLength(1);
	});

	it("prints package version metadata", async () => {
		const packageJson = JSON.parse(
			await readFile(resolve(projectRoot, "package.json"), "utf8"),
		) as { name: string; version: string };
		const result = runCli({ args: ["--version"] });

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

		const result = runCli({ args: ["unrelated"] });

		expect(result.status).not.toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(
			/command unrelated not found/i,
		);
		expect(existsSync(importSentinelPath)).toBe(false);
	});
});
