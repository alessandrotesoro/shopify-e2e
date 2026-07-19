import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRoleStateStore } from "../src/role-states/role-state-store.js";

import {
	prepareDoctorReadyConsumer,
	waitForChildOutcome,
	waitForPath,
} from "./support/doctor-cli-shell.js";

const projectRoot = resolve(import.meta.dirname, "..");
const configHelperPath = resolve(projectRoot, "src/config/public.cts");
const binPath = resolve(projectRoot, "bin/run.js");
const unrelatedCommandPath = resolve(projectRoot, "dist/commands/unrelated.js");
const importSentinelPath = resolve(projectRoot, "dist/unrelated-imported");
const temporaryDirectories: string[] = [];
const consumerDataRoots = new Map<string, string>();
let sharedConsumerPeerRoot: string;
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
		env: {
			...process.env,
			NO_COLOR: "1",
			...(consumerDataRoots.get(cwd) === undefined
				? {}
				: { SHOPIFY_E2E_DATA_DIR: consumerDataRoots.get(cwd) }),
			SHOPIFY_STORE_URL: "https://shop.example",
			...environmentOverrides,
		},
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
		`import { defineShopifyE2EConfig } from ${JSON.stringify(configHelperPath)}; export default defineShopifyE2EConfig({ testDir: "shopify-tests", roles: ["admin", "guest"] });\n`,
	);
	await writeFile(
		join(testDir, "checkout.spec.ts"),
		'import { test } from "@playwright/test";\ntest("shopify checkout", { tag: "@shopify-e2e-role-guest" }, () => {});\n',
	);
	return consumer;
};

const makeRunnableConsumer = async (consumerRoot?: string): Promise<string> => {
	const consumer = await makeConsumerFixture(consumerRoot);
	const dataRoot = await realpath(
		await mkdtemp(join(tmpdir(), "shopify-e2e-cli-role-states-")),
	);
	temporaryDirectories.push(dataRoot);
	consumerDataRoots.set(consumer, dataRoot);
	await seedRole(consumer, dataRoot);
	await writeFile(join(consumer, ".env"), `SHOPIFY_E2E_DATA_DIR=${dataRoot}\n`);
	await mkdir(join(consumer, "node_modules", "@playwright"), {
		recursive: true,
	});
	await symlink(
		join(sharedConsumerPeerRoot, "node_modules", "@playwright", "test"),
		join(consumer, "node_modules", "@playwright", "test"),
		"dir",
	);
	return consumer;
};

const makeDotenvAwareConsumer = async (): Promise<string> => {
	const consumer = await makeRunnableConsumer();
	await writeFile(
		join(consumer, "shopify-e2e.config.ts"),
		`import { defineShopifyE2EConfig } from ${JSON.stringify(configHelperPath)}; const isExpected = process.env.SHOPIFY_E2E_DOTENV_SENTINEL === process.env.SHOPIFY_E2E_DOTENV_EXPECTED && process.env.DOTENV_CONFIG_DEBUG === process.env.SHOPIFY_E2E_DOTENV_EXPECTED_DEBUG && process.env.DOTENV_CONFIG_QUIET === process.env.SHOPIFY_E2E_DOTENV_EXPECTED_QUIET; export default defineShopifyE2EConfig({ testDir: isExpected ? "shopify-tests" : "missing-tests", roles: ["guest"] });\n`,
	);
	await writeFile(
		join(consumer, "shopify-tests", "checkout.spec.ts"),
		'import { expect, test } from "@playwright/test";\ntest("dotenv reaches Playwright", { tag: "@shopify-e2e-role-guest" }, () => { expect(process.env.SHOPIFY_E2E_DOTENV_SENTINEL).toBe(process.env.SHOPIFY_E2E_DOTENV_EXPECTED); expect(process.env.DOTENV_CONFIG_DEBUG).toBe(process.env.SHOPIFY_E2E_DOTENV_EXPECTED_DEBUG); expect(process.env.DOTENV_CONFIG_QUIET).toBe(process.env.SHOPIFY_E2E_DOTENV_EXPECTED_QUIET); });\n',
	);
	return consumer;
};

const seedRole = async (
	_consumer: string,
	dataRoot: string,
	role = "guest",
): Promise<void> => {
	await createRoleStateStore({
		dataRoot,
		origin: "https://shop.example",
		roles: ["admin", "guest"],
	}).capture({ role, state: { cookies: [], origins: [] } });
};

const makeConsumerWithExitingPlaywright = async (
	exitCode: number,
): Promise<string> => {
	const consumer = await makeConsumerFixture();
	const dataRoot = await realpath(
		await mkdtemp(join(tmpdir(), "shopify-e2e-cli-role-states-")),
	);
	temporaryDirectories.push(dataRoot);
	consumerDataRoots.set(consumer, dataRoot);
	await seedRole(consumer, dataRoot);
	await writeFile(join(consumer, ".env"), `SHOPIFY_E2E_DATA_DIR=${dataRoot}\n`);
	const peerRoot = join(consumer, "node_modules", "@playwright", "test");
	await mkdir(peerRoot, { recursive: true });
	await writeFile(
		join(peerRoot, "package.json"),
		`${JSON.stringify(
			{
				bin: { playwright: "cli.js" },
				exports: {
					".": "./index.js",
					"./package.json": "./package.json",
				},
				name: "@playwright/test",
				type: "module",
				version: "1.61.1",
			},
			null,
			2,
		)}\n`,
	);
	await writeFile(join(peerRoot, "cli.js"), `process.exit(${exitCode});\n`);
	await writeFile(
		join(peerRoot, "index.js"),
		`import { EventEmitter } from "node:events";
class Server extends EventEmitter {
  async close() { this.emit("close"); }
  async kill() { this.emit("close"); }
  wsEndpoint() { return "ws://127.0.0.1/fake-playwright-server"; }
}
export const chromium = {
  executablePath() { return process.execPath; },
  launch() {},
  async launchServer() { return new Server(); },
};
`,
	);
	return consumer;
};

describe.sequential("built CLI shell", () => {
	beforeAll(async () => {
		sharedConsumerPeerRoot = await mkdtemp(
			join(tmpdir(), "shopify-e2e-cli-peer-"),
		);
		await mkdir(join(sharedConsumerPeerRoot, "node_modules", "@playwright"), {
			recursive: true,
		});
		await Promise.all([
			cp(
				join(projectRoot, "node_modules", "@playwright", "test"),
				join(sharedConsumerPeerRoot, "node_modules", "@playwright", "test"),
				{ recursive: true },
			),
			cp(
				join(projectRoot, "node_modules", "playwright"),
				join(sharedConsumerPeerRoot, "node_modules", "playwright"),
				{ recursive: true },
			),
			cp(
				join(projectRoot, "node_modules", "playwright-core"),
				join(sharedConsumerPeerRoot, "node_modules", "playwright-core"),
				{ recursive: true },
			),
		]);
	});

	afterAll(async () => {
		await rm(sharedConsumerPeerRoot, { force: true, recursive: true });
	});

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
		expect(result.stdout).toMatch(/\bdoctor\b/);
		expect(result.stdout).toMatch(/\bauth\b/);
		expect(result.stdout).toContain("auth remove");
		expect(result.stderr).toBe("");
	});

	it("documents the exact doctor surface", () => {
		const result = runCli({ args: ["doctor", "--help"] });

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("shopify-e2e doctor");
		const flagNames = result.stdout
			.split("\n")
			.filter((line) => /^ {2}--/.test(line))
			.map((line) => line.trim().split(/\s+/)[0]);
		expect(flagNames).toEqual([]);
		expect(result.stdout).not.toContain("--config");
		expect(result.stderr).toBe("");
	});

	it.each([
		["doctor", "unexpected"],
		["doctor", "--unknown"],
		["doctor", "--config", "alternate-shopify-e2e.config.ts"],
		["doctor", "--", "unexpected"],
	])("rejects unsupported doctor input before orchestration: %s", async (...args) => {
		const consumer = await makeConsumerFixture();
		await mkdir(join(consumer, ".env"));

		const result = runCli({ args, cwd: consumer });

		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(
			/unexpected argument|nonexistent flag|command .* not found/i,
		);
		expect(result.stdout).not.toContain("Project:");
		expect(result.stderr).not.toMatch(/consumer \.env could not be read/i);
	});

	it("prints the complete fixed-config doctor report without importing tests", async () => {
		const fixture = await prepareDoctorReadyConsumer(
			await makeConsumerFixture(),
		);
		const physicalConsumer = await realpath(fixture.consumer);
		const configPath = join(physicalConsumer, "shopify-e2e.config.ts");
		const testDir = join(physicalConsumer, "shopify-tests");

		const result = runCli({
			args: ["doctor"],
			cwd: fixture.consumer,
		});

		expect(result.status, result.stderr).toBe(0);
		const labels = [
			"Project",
			"Environment",
			"Store URL",
			"Shopify config",
			"Shopify test directory",
			"Playwright peer",
			"Chromium",
		];
		let priorIndex = -1;
		for (const label of labels) {
			const index = result.stdout.indexOf(`PASS ${label}:`);
			expect(index).toBeGreaterThan(priorIndex);
			priorIndex = index;
		}
		expect(result.stdout).toContain(configPath);
		expect(result.stdout).toContain(testDir);
		expect(result.stdout).toContain(
			"Package-owned Shopify config checks passed",
		);
		expect(result.stdout).toContain(
			"1 JavaScript/TypeScript file candidate(s) found",
		);
		expect(result.stdout).not.toMatch(/runnable Playwright specs/i);
		expect(result.stdout).not.toContain("checkout.spec.ts");
		expect(result.stdout).not.toContain("https://shop.example");
		expect(result.stderr).toBe("");
		for (const sentinel of [
			...fixture.importSentinels,
			fixture.launchSentinel,
		]) {
			expect(existsSync(sentinel)).toBe(false);
		}
	});

	it("prints doctor failures and skips before exiting with code 2", async () => {
		const consumer = await makeConsumerFixture();

		const result = runCli({ args: ["doctor"], cwd: consumer });

		expect(result.status).toBe(2);
		expect(result.stdout).toMatch(/FAIL Playwright peer:/);
		expect(result.stdout).toMatch(/SKIP Chromium:/);
		expect(result.stderr).toBe("");
	});

	it.skipIf(process.platform === "win32").each([
		["SIGINT", 130],
		["SIGTERM", 143],
	] as const)(
		"interrupts an in-flight doctor inspection with %s without a partial report",
		async (signal, expectedExitCode) => {
			const fixture = await prepareDoctorReadyConsumer(
				await makeConsumerFixture(),
			);
			const inspectionStarted = join(
				fixture.consumer,
				"doctor-inspection-started",
			);
			const laterCheckMarker = join(
				fixture.consumer,
				"doctor-later-check-started",
			);
			const peerRoot = join(
				fixture.consumer,
				"node_modules",
				"@playwright",
				"test",
			);
			await writeFile(
				join(fixture.consumer, "shopify-e2e.config.ts"),
				`import { writeFileSync } from "node:fs";
import { defineShopifyE2EConfig } from ${JSON.stringify(configHelperPath)};
writeFileSync(${JSON.stringify(inspectionStarted)}, "started");
await new Promise((resolveSignal) => {
  const keepInspectionPending = setInterval(() => undefined, 1_000);
  process.once(${JSON.stringify(signal)}, () => {
    clearInterval(keepInspectionPending);
    resolveSignal(undefined);
  });
});
export default defineShopifyE2EConfig({ testDir: "shopify-tests", roles: ["guest"] });
`,
			);
			await writeFile(
				join(peerRoot, "index.js"),
				`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(laterCheckMarker)}, "started");
export const chromium = {
  executablePath() { return ${JSON.stringify(join(peerRoot, "chromium"))}; },
  launch() {
    writeFileSync(${JSON.stringify(fixture.launchSentinel)}, "launched");
    throw new Error("doctor must not launch Chromium");
  },
};
`,
			);

			const child = spawn(process.execPath, [binPath, "doctor"], {
				cwd: fixture.consumer,
				env: {
					...process.env,
					NO_COLOR: "1",
					SHOPIFY_STORE_URL: "https://shop.example",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
			});
			const outcomePromise = waitForChildOutcome(child, 10_000);
			let didExit = false;

			try {
				await waitForPath(inspectionStarted, 5_000);
				expect(child.pid).toBeTypeOf("number");
				process.kill(child.pid as number, signal);
				const outcome = await outcomePromise;
				didExit = true;

				expect(
					outcome,
					`interrupted doctor\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				).toEqual({ code: expectedExitCode, signal: null });
				expect(stderr).toContain("Doctor interrupted; no report completed.");
				expect(stderr).not.toContain(fixture.consumer);
				expect(stdout).not.toMatch(/^(?:PASS|FAIL|ERROR|SKIP) /m);
				expect(existsSync(laterCheckMarker)).toBe(false);
				expect(existsSync(fixture.launchSentinel)).toBe(false);
			} finally {
				if (!didExit && child.exitCode === null && child.signalCode === null) {
					child.kill("SIGKILL");
					await waitForChildOutcome(child, 2_000).catch(() => undefined);
				}
			}
		},
		15_000,
	);

	it.each([
		{ args: ["auth", "--help"], flags: [] },
		{
			args: ["auth", "capture", "--help"],
			flags: ["--role"],
		},
		{
			args: ["auth", "refresh", "--help"],
			flags: ["--role"],
		},
		{
			args: ["auth", "remove", "--help"],
			flags: ["--role", "--yes"],
		},
		{ args: ["auth", "list", "--help"], flags: [] },
	])("prints auth help for $args", ({ args, flags }) => {
		const result = runCli({ args });

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("USAGE");
		for (const flag of flags) expect(result.stdout).toContain(flag);
		expect(result.stdout).not.toContain("--profile");
		expect(result.stdout).not.toContain("--config");
		expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
			/password.*prompt/i,
		);
	});

	it("documents the exact removal flags and automation contract", () => {
		const result = runCli({ args: ["auth", "remove", "--help"] });

		expect(result.status).toBe(0);
		const flagNames = result.stdout
			.split("\n")
			.filter((line) => /^ {2}--/.test(line))
			.map((line) => line.trim().split(/\s+/)[0]);
		expect(flagNames).toEqual(["--role=<value>", "--yes"]);
		expect(result.stdout).toMatch(/--yes.*skip confirmation/is);
		expect(result.stdout).toMatch(
			/non-interactive removal requires\s+--role and\s+--yes/i,
		);
		expect(result.stdout).not.toContain("--profile");
		expect(result.stdout).not.toContain("--config");
	});

	it("documents capture's sole role selector", () => {
		const result = runCli({ args: ["auth", "capture", "--help"] });

		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(
			/--role.*ASCII lower-kebab, max 64 UTF-8 bytes/s,
		);
		expect(result.stdout).not.toContain("--profile");
		expect(result.stdout).not.toContain("--config");
	});

	it("lists the exact auth command vocabulary", () => {
		const result = runCli({ args: ["auth", "--help"] });

		expect(result.status).toBe(0);
		const commandLines = result.stdout
			.split("\n")
			.filter((line) => /^ {2}auth (capture|list|refresh|remove)\b/.test(line));
		expect(commandLines).toHaveLength(4);
		expect(commandLines.join("\n")).toMatch(/auth capture/);
		expect(commandLines.join("\n")).toMatch(/auth list/);
		expect(commandLines.join("\n")).toMatch(/auth refresh/);
		expect(commandLines.join("\n")).toMatch(/auth remove/);
	});

	it.each([
		["auth", "unknown"],
		["auth", "capture", "unexpected"],
		["auth", "refresh", "unexpected"],
		["auth", "list", "unexpected"],
		["auth", "--profile", "admin-primary"],
		["auth", "--config", "other.ts"],
		["auth", "capture", "--profile", "admin-primary"],
		["auth", "capture", "--config", "other.ts"],
		["auth", "list", "--role", "admin"],
		["auth", "list", "--config", "other.ts"],
		["auth", "refresh", "--profile", "admin-primary"],
		["auth", "refresh", "--config", "other.ts"],
		["auth", "remove", "--profile", "admin-primary"],
		["auth", "remove", "--config", "other.ts"],
		["auth", "capture", "--unknown"],
	])("rejects unsupported auth input before preflight: %s", (...args) => {
		const result = runCli({ args });

		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(
			/unexpected argument|nonexistent flag|command .* not found/i,
		);
	});

	it("rejects auth syntax before reading the consumer environment", async () => {
		const consumer = await makeConsumerFixture();
		await mkdir(join(consumer, ".env"));

		const result = runCli({
			args: ["auth", "capture", "unexpected"],
			cwd: consumer,
		});

		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(/command .* not found|unexpected argument/i);
		expect(result.stderr).not.toMatch(/consumer \.env could not be read/i);
	});

	it.each([
		["auth", "remove", "unexpected"],
		["auth", "remove", "--unknown"],
		["auth", "remove", "--yes=false"],
		["auth", "remove", "--yes", "false"],
		["auth", "remove", "--no-yes"],
	])("rejects removal syntax before orchestration: %s", async (...args) => {
		const consumer = await makeConsumerFixture();
		await mkdir(join(consumer, ".env"));

		const result = runCli({ args, cwd: consumer });

		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(
			/unexpected argument|nonexistent flag|command .* not found/i,
		);
		expect(result.stderr).not.toMatch(/consumer \.env could not be read/i);
	});

	it.each([
		[],
		["--role", "admin"],
		["--yes"],
	])("requires the non-interactive removal flag pair for %s", async (...flags) => {
		const consumer = await makeConsumerFixture();

		const result = runCli({
			args: ["auth", "remove", ...flags],
			cwd: consumer,
		});

		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(/--role.*--yes/i);
		expect(result.stderr).not.toMatch(
			/inquirer|exitprompterror|abortprompterror/i,
		);
	});

	it("passes oclif's external data-directory override to auth orchestration", async () => {
		const consumer = await makeConsumerFixture();
		const dataParent = await realpath(
			await mkdtemp(join(tmpdir(), "shopify-e2e-auth-data-")),
		);
		temporaryDirectories.push(dataParent);

		const result = runCli({
			args: ["auth", "list"],
			cwd: consumer,
			environmentOverrides: {
				SHOPIFY_E2E_DATA_DIR: join(dataParent, "role-states"),
			},
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("admin\tmissing");
		expect(result.stdout).toContain("guest\tmissing");
	});

	it("rejects an auth data-directory override inside the consumer before persistence", async () => {
		const consumer = await makeConsumerFixture();
		const physicalConsumer = await realpath(consumer);

		const result = runCli({
			args: ["auth", "list"],
			cwd: consumer,
			environmentOverrides: {
				SHOPIFY_E2E_DATA_DIR: join(physicalConsumer, ".role-states"),
			},
		});

		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(
			/role-state data directory.*outside the consumer project/i,
		);
		expect(existsSync(join(physicalConsumer, ".role-states"))).toBe(false);
	});

	it("prints run command help", () => {
		const result = runCli({ args: ["run", "--help"] });

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("USAGE");
		expect(result.stdout).toContain("shopify-e2e run");
		expect(result.stdout).toContain(
			"arbitrary Playwright arguments are not accepted",
		);
		expect(result.stdout).not.toContain("--config");
		expect(result.stdout).toContain("--grep");
		expect(result.stdout).toContain("-g");
		expect(result.stdout).toContain("--grep-invert");
		expect(result.stdout).toContain("--role");
		expect(result.stdout).not.toContain("--profile");
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
		const result = runCli({
			args: ["run", "--role", "guest"],
			cwd: consumer,
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toMatch(/1 passed/i);
		expect(result.stderr).toContain("Shopify config:");
		expect(result.stderr).toContain("shopify-e2e.config.ts");
		expect(result.stderr).toContain("Shopify test directory:");
		expect(result.stderr).toContain("shopify-tests");
		expect(result.stderr).toContain("Shopify role: guest");
	});

	it("requires --role when run is non-interactive", async () => {
		const consumer = await makeRunnableConsumer();
		const dataParent = await realpath(
			await mkdtemp(join(tmpdir(), "shopify-e2e-run-data-")),
		);
		temporaryDirectories.push(dataParent);
		const result = runCli({
			args: ["run"],
			cwd: consumer,
			environmentOverrides: {
				SHOPIFY_E2E_DATA_DIR: join(dataParent, "role-states"),
			},
		});

		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(/role is required.*--role/i);
	});

	it("rejects an in-project role-state data directory", async () => {
		const consumer = await makeRunnableConsumer();
		const result = runCli({
			args: ["run", "--role", "guest"],
			cwd: consumer,
			environmentOverrides: {
				SHOPIFY_E2E_DATA_DIR: join(consumer, ".forbidden-role-state-data"),
			},
		});

		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(
			/role-state data directory.*(?:outside|symbolic)/i,
		);
		expect(existsSync(join(consumer, ".forbidden-role-state-data"))).toBe(
			false,
		);
	});

	it("rejects a missing store URL before resolving the consumer peer", async () => {
		const consumer = await makeConsumerFixture();
		const result = runCli({
			args: ["run", "--role", "guest"],
			cwd: consumer,
			environmentOverrides: { SHOPIFY_STORE_URL: undefined },
		});

		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(/SHOPIFY_STORE_URL is required/);
		expect(result.stderr).not.toMatch(/@playwright\/test/i);
	});

	it("loads cwd .env before config and exposes the same value to Playwright", async () => {
		const consumer = await makeDotenvAwareConsumer();
		await writeFile(
			join(consumer, ".env"),
			`SHOPIFY_E2E_DATA_DIR=${consumerDataRoots.get(consumer)}\nSHOPIFY_E2E_DOTENV_SENTINEL=from-consumer-dotenv\nDOTENV_CONFIG_DEBUG=1\nDOTENV_CONFIG_QUIET=false\n`,
		);
		const result = runCli({
			args: ["run", "--role", "guest"],
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
			`SHOPIFY_E2E_DATA_DIR=${consumerDataRoots.get(consumer)}\nSHOPIFY_E2E_DOTENV_SENTINEL=from-consumer-dotenv\n`,
		);
		const result = runCli({
			args: ["run", "--role", "guest"],
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
		await rm(join(consumer, ".env"), { force: true });
		await mkdir(join(consumer, ".env"));
		await writeFile(
			join(consumer, "shopify-e2e.config.ts"),
			`import { writeFileSync } from "node:fs"; import { defineShopifyE2EConfig } from ${JSON.stringify(configHelperPath)}; writeFileSync(${JSON.stringify(configMarker)}, "loaded"); export default defineShopifyE2EConfig({ testDir: "shopify-tests", roles: ["guest"] });\n`,
		);
		const result = runCli({
			args: ["run", "--role", "guest"],
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
		{ args: ["run", "--grep", ""], status: 2 },
		{ args: ["run", "--grep-invert", "   "], status: 2 },
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

	it("rejects nested --config selection before execution", async () => {
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
			`import { defineShopifyE2EConfig } from ${JSON.stringify(configHelperPath)}; export default defineShopifyE2EConfig({ testDir: process.env.SHOPIFY_E2E_DOTENV_SENTINEL === "invocation-root" ? "shopify-tests" : "missing-tests", roles: ["guest"] });\n`,
		);
		await writeFile(
			join(nestedTests, "dotenv.spec.ts"),
			'import { expect, test } from "@playwright/test"; test("root-only dotenv", { tag: "@shopify-e2e-role-guest" }, () => { expect(process.env.SHOPIFY_E2E_DOTENV_SENTINEL).toBe("invocation-root"); });\n',
		);
		const result = runCli({
			args: [
				"run",
				"--config",
				"nested/shopify-e2e.config.ts",
				"--role",
				"guest",
			],
			cwd: consumer,
			environmentOverrides: { SHOPIFY_E2E_DOTENV_SENTINEL: undefined },
		});

		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(/nonexistent flag.*config/i);
	});

	it("preserves Playwright's exit when an allowed filter selects no tests", async () => {
		const consumer = await makeRunnableConsumer();
		const result = runCli({
			args: ["run", "--role", "guest", "--grep", "does not match"],
			cwd: consumer,
		});

		expect(result.status).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toMatch(/no tests found/i);
		expect(result.stderr).not.toMatch(/config.*invalid|preflight/i);
	});

	it("preserves a representative nonstandard Playwright child exit", async () => {
		const consumer = await makeConsumerWithExitingPlaywright(17);
		const result = runCli({
			args: ["run", "--role", "guest"],
			cwd: consumer,
		});

		expect(result.status, result.stderr).toBe(17);
		expect(result.stderr).toContain("Shopify config:");
		expect(result.stderr).toContain("Shopify test directory:");
	});

	it("reports browser startup failures as one safe infrastructure error", async () => {
		const consumer = await makeRunnableConsumer();
		const missingTemporaryRoot = join(
			consumer,
			"missing-temporary-parent",
			"private-value",
		);
		const result = runCli({
			args: ["run", "--role", "guest"],
			cwd: consumer,
			environmentOverrides: {
				TEMP: missingTemporaryRoot,
				TMP: missingTemporaryRoot,
				TMPDIR: missingTemporaryRoot,
			},
		});

		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(/consumer chromium server could not launch/i);
		expect(result.stderr.match(/Error:/g)).toHaveLength(1);
		expect(result.stderr).not.toContain("private-value");
	});

	it("reports a missing dedicated config as preflight exit 2", async () => {
		const consumer = await mkdtemp(join(tmpdir(), "shopify-e2e-cli-"));
		temporaryDirectories.push(consumer);
		const result = runCli({
			args: ["run", "--role", "guest"],
			cwd: consumer,
		});

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
