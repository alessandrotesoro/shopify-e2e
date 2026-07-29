import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRoleStateStore } from "../src/role-states/role-state-store.js";
import {
	cleanupInstalledCliFixture,
	makeTemporaryDirectory,
	packVerifiedPackage,
} from "./support/installed-cli-harness.js";
import {
	installedCliPath,
	installPackedPackage,
} from "./support/installed-consumer.js";

const projectRoot = resolve(import.meta.dirname, "..");
const origin = "https://shop.example";

interface InstalledConsumer {
	readonly dataRoot: string;
	readonly root: string;
	readonly runtimeTempRoot: string;
}

const isProcessAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
};

const descendantPids = (rootPid: number): readonly number[] => {
	const listing = spawnSync("ps", ["-axo", "pid=,ppid="], {
		encoding: "utf8",
	});
	if (listing.status !== 0) {
		throw new Error(`Could not inspect descendants: ${listing.stderr}`);
	}
	const children = new Map<number, number[]>();
	for (const line of listing.stdout.trim().split("\n")) {
		const [pidText, parentText] = line.trim().split(/\s+/);
		const pid = Number(pidText);
		const parent = Number(parentText);
		if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
		const selected = children.get(parent) ?? [];
		selected.push(pid);
		children.set(parent, selected);
	}
	const descendants: number[] = [];
	const pending = [...(children.get(rootPid) ?? [])];
	while (pending.length > 0) {
		const pid = pending.shift();
		if (pid === undefined || descendants.includes(pid)) continue;
		descendants.push(pid);
		pending.push(...(children.get(pid) ?? []));
	}
	return descendants;
};

const processCommand = (pid: number): string =>
	spawnSync("ps", ["-p", String(pid), "-o", "command="], {
		encoding: "utf8",
	}).stdout.trim();

const waitForProcessToExit = async (
	pid: number,
	timeout: number,
): Promise<void> => {
	try {
		await expect
			.poll(() => isProcessAlive(pid), { interval: 25, timeout })
			.toBe(false);
	} catch (error) {
		const processState = spawnSync(
			"ps",
			["-p", String(pid), "-o", "pid=,ppid=,command="],
			{ encoding: "utf8" },
		).stdout.trim();
		throw new Error(`Process ${pid} remained alive: ${processState}`, {
			cause: error,
		});
	}
};

const waitForChildToExit = async (
	child: ChildProcess,
	timeout: number,
): Promise<void> => {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolveExit, rejectExit) => {
		let timer: NodeJS.Timeout;
		const cleanup = (): void => {
			clearTimeout(timer);
			child.off("error", onError);
			child.off("exit", onExit);
		};
		const onError = (error: Error): void => {
			cleanup();
			rejectExit(error);
		};
		const onExit = (): void => {
			cleanup();
			resolveExit();
		};
		child.once("error", onError);
		child.once("exit", onExit);
		timer = setTimeout(() => {
			cleanup();
			rejectExit(new Error("Installed CLI did not exit"));
		}, timeout);
		timer.unref();
	});
};

const signalProcess = (pid: number, signal: NodeJS.Signals): void => {
	try {
		process.kill(pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
};

const findAvailablePort = async (): Promise<number> =>
	new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close();
				reject(new Error("Could not allocate a web server fixture port"));
				return;
			}
			server.close((error) => {
				if (error) reject(error);
				else resolvePort(address.port);
			});
		});
	});

const runCli = (
	consumer: InstalledConsumer,
	args: readonly string[],
	overrides: NodeJS.ProcessEnv = {},
) =>
	spawnSync(installedCliPath(consumer.root), args, {
		cwd: consumer.root,
		encoding: "utf8",
		env: {
			...process.env,
			NO_COLOR: "1",
			SHOPIFY_E2E_DATA_DIR: consumer.dataRoot,
			SHOPIFY_STORE_URL: origin,
			...overrides,
			TEMP: consumer.runtimeTempRoot,
			TMP: consumer.runtimeTempRoot,
			TMPDIR: consumer.runtimeTempRoot,
		},
		killSignal: "SIGKILL",
		maxBuffer: 10 * 1024 * 1024,
		timeout: 30_000,
	});

const seedRole = async (
	consumer: InstalledConsumer,
	role: string,
	value: string,
): Promise<void> => {
	await createRoleStateStore({
		dataRoot: consumer.dataRoot,
		origin,
		roles: ["admin", "customer"],
	}).capture({
		role,
		state: {
			cookies: [
				{
					domain: "shop.example",
					expires: -1,
					httpOnly: true,
					name: "installed-role-sentinel",
					path: "/",
					sameSite: "Lax",
					secure: true,
					value,
				},
			],
			origins: [],
		},
	});
};

const prepareEsmConsumer = async (
	tarballPath: string,
): Promise<InstalledConsumer> => {
	const root = await makeTemporaryDirectory("shopify-e2e-installed-esm-");
	const webServerPort = await findAvailablePort();
	const webServerUrl = `http://127.0.0.1:${webServerPort}`;
	const dataRoot = await makeTemporaryDirectory(
		"shopify-e2e-installed-role-states-",
	);
	const runtimeTempRoot = await makeTemporaryDirectory(
		"shopify-e2e-installed-runtime-",
	);
	await writeFile(
		join(root, "package.json"),
		'{"name":"installed-esm-consumer","private":true,"type":"module"}\n',
	);
	await installPackedPackage({
		consumerRoot: root,
		hasPlaywright: true,
		tarballPath,
	});
	await mkdir(join(root, "node_modules", "fixture-dependency"));
	await writeFile(
		join(root, "node_modules", "fixture-dependency", "package.json"),
		'{"name":"fixture-dependency","type":"module","exports":"./index.js"}\n',
	);
	await writeFile(
		join(root, "node_modules", "fixture-dependency", "index.js"),
		"export const retryCount = 1;\n",
	);
	await mkdir(join(root, "shopify-tests"));
	await mkdir(join(root, "ordinary-tests"));
	await writeFile(
		join(root, "config-helper.ts"),
		`import type { PlaywrightTestConfig } from "@playwright/test";
import { devices } from "@playwright/test";
import { retryCount } from "fixture-dependency";
export const normalSettings = {
  expect: { timeout: 150 },
  metadata: { installed: true, webServerUrl: ${JSON.stringify(webServerUrl)} },
  repeatEach: 2,
  retries: retryCount,
  timeout: 2_000,
  use: { ...devices["Desktop Chrome"], screenshot: "off", trace: "off", video: "off" },
} satisfies PlaywrightTestConfig;
`,
	);
	await writeFile(
		join(root, "shopify-e2e.config.ts"),
		`import { defineShopifyE2EConfig } from "@sematico/shopify-e2e/config";
import { normalSettings } from "./config-helper.ts";
export default defineShopifyE2EConfig({
  ...normalSettings,
  globalSetup: "./setup.ts",
  globalTeardown: "./teardown.ts",
  outputDir: "artifacts/output",
  reporter: [["json", { outputFile: "artifacts/results.json" }]],
  roles: ["admin", "customer"],
  testDir: "shopify-tests",
  webServer: {
    command: "node ./web-server.mjs",
    reuseExistingServer: false,
    timeout: 10_000,
    url: ${JSON.stringify(`${webServerUrl}/ready`)},
  },
});
`,
	);
	await writeFile(
		join(root, "web-server.mjs"),
		`import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ready");
});
server.listen(${webServerPort}, "127.0.0.1", () => writeFileSync("web-server.marker", "started"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`,
	);
	await writeFile(
		join(root, "setup.ts"),
		'import { appendFile, writeFile } from "node:fs/promises"; export default async () => { await writeFile("setup.marker", "setup"); await appendFile("lifecycle.marker", "setup\\n"); };\n',
	);
	await writeFile(
		join(root, "teardown.ts"),
		'import { appendFile, writeFile } from "node:fs/promises"; export default async () => { await writeFile("teardown.marker", "teardown"); await appendFile("lifecycle.marker", "teardown\\n"); };\n',
	);
	await writeFile(
		join(root, "playwright.config.ts"),
		'import { writeFileSync } from "node:fs"; writeFileSync("ordinary-config.marker", "loaded"); export default { testDir: "ordinary-tests" };\n',
	);
	await writeFile(
		join(root, "ordinary-tests", "ordinary.spec.ts"),
		'import { writeFileSync } from "node:fs"; writeFileSync("ordinary-spec.marker", "loaded");\n',
	);
	await writeFile(
		join(root, "shopify-tests", "roles.spec.ts"),
		`import { appendFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
test("admin packed lane", { tag: "@shopify-e2e-role-admin" }, async ({}, testInfo) => {
  expect(testInfo.config.metadata.installed).toBe(true);
  expect(testInfo.project.outputDir).toBe(resolve("artifacts/output"));
  expect(testInfo.project.repeatEach).toBe(2);
  expect(testInfo.project.retries).toBe(1);
  expect(testInfo.project.testDir).toBe(resolve("shopify-tests"));
  expect(testInfo.project.timeout).toBe(2_000);
  expect(testInfo.project.use.screenshot).toBe("off");
  expect(testInfo.project.use.trace).toBe("off");
  expect(testInfo.project.use.video).toBe("off");
  expect(testInfo.project.use.viewport).toEqual({ height: 720, width: 1280 });
  const state = testInfo.project.use.storageState;
  expect(typeof state).toBe("object");
  expect(state.cookies[0].value).toBe("admin-state");
  const response = await fetch(testInfo.config.metadata.webServerUrl);
  expect(await response.text()).toBe("ready");
  const expectStartedAt = Date.now();
  let expectTimedOut = false;
  try {
    await expect.poll(() => false).toBe(true);
  } catch {
    expectTimedOut = true;
  }
  expect(expectTimedOut).toBe(true);
  expect(Date.now() - expectStartedAt).toBeLessThan(1_000);
  appendFileSync("repeat.marker", String(testInfo.repeatEachIndex) + "\\n");
  appendFileSync("lifecycle.marker", "admin\\n");
  writeFileSync("admin-body.marker", "ran");
});
test("admin interrupt lane", { tag: "@shopify-e2e-role-admin" }, async () => {
  test.skip(process.env.SHOPIFY_E2E_INTERRUPT_ACTIVE !== "1", "interrupt fixture only");
  test.setTimeout(15_000);
  const markerDirectory = process.env.SHOPIFY_E2E_MARKER_DIR;
  if (!markerDirectory) throw new Error("SHOPIFY_E2E_MARKER_DIR is required");
  writeFileSync(join(markerDirectory, "interrupt-started.marker"), JSON.stringify({ pid: process.pid, ppid: process.ppid }));
  await new Promise(() => undefined);
});
test("admin fail-fast lane", { tag: "@shopify-e2e-role-admin" }, async () => {
  test.skip(process.env.SHOPIFY_E2E_FAIL_FAST_ACTIVE !== "1", "fail-fast fixture only");
  writeFileSync("admin-fail-fast.marker", "ran");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  expect(false).toBe(true);
});
test("customer packed lane", { tag: "@shopify-e2e-role-customer" }, ({}, testInfo) => {
  const state = testInfo.project.use.storageState;
  expect(typeof state).toBe("object");
  expect(state.cookies[0].value).toBe("customer-state");
  appendFileSync("lifecycle.marker", "customer\\n");
  writeFileSync("customer-body.marker", "ran");
});
test("customer after failure lane", { tag: "@shopify-e2e-role-customer" }, () => {
  test.skip(process.env.SHOPIFY_E2E_FAIL_FAST_ACTIVE !== "1", "fail-fast fixture only");
  writeFileSync("customer-after-failure.marker", "ran");
});
`,
	);
	const consumer = { dataRoot, root, runtimeTempRoot };
	await seedRole(consumer, "admin", "admin-state");
	await seedRole(consumer, "customer", "customer-state");
	return consumer;
};

describe.sequential("installed CLI release boundary", () => {
	let esm: InstalledConsumer;

	beforeAll(async () => {
		const tarballPath = await packVerifiedPackage(projectRoot);
		esm = await prepareEsmConsumer(tarballPath);
	}, 240_000);

	afterAll(cleanupInstalledCliFixture);

	it("publishes one role-only CLI surface", () => {
		const rootHelp = runCli(esm, ["--help"]);
		const runHelp = runCli(esm, ["run", "--help"]);
		const authHelp = runCli(esm, ["auth", "--help"]);
		const version = runCli(esm, ["--version"]);
		for (const result of [rootHelp, runHelp, authHelp, version]) {
			expect(result.status, result.stderr).toBe(0);
		}
		expect(runHelp.stdout).toContain("--role");
		expect(runHelp.stdout).toMatch(/repeatable.*omit.*select roles/is);
		expect(runHelp.stdout).not.toContain("--profile");
		expect(runHelp.stdout).not.toContain("--config");
		expect(authHelp.stdout).not.toContain("--profile");
		expect(version.stdout).toContain("0.7.0");
	});

	it("runs packed ESM roles serially in one CLI browser lifecycle", async () => {
		const result = runCli(esm, [
			"run",
			"--role",
			"customer",
			"--role",
			"admin",
		]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toMatch(/admin: passed[\s\S]*customer: passed/);
		expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
			/admin-state|customer-state|PW_TEST_CONNECT|ws:\/\/|shopify-e2e-context-/,
		);
		await expect(
			access(join(esm.root, "admin-body.marker")),
		).resolves.toBeUndefined();
		await expect(
			access(join(esm.root, "customer-body.marker")),
		).resolves.toBeUndefined();
		await expect(
			access(join(esm.root, "ordinary-config.marker")),
		).rejects.toThrow();
		await expect(
			access(join(esm.root, "ordinary-spec.marker")),
		).rejects.toThrow();
		await expect(
			access(join(esm.root, "setup.marker")),
		).resolves.toBeUndefined();
		await expect(
			access(join(esm.root, "teardown.marker")),
		).resolves.toBeUndefined();
		await expect(
			access(join(esm.root, "web-server.marker")),
		).resolves.toBeUndefined();
		expect(
			(await readFile(join(esm.root, "repeat.marker"), "utf8"))
				.trim()
				.split("\n")
				.sort(),
		).toEqual(["0", "1"]);
		expect(
			(await readFile(join(esm.root, "lifecycle.marker"), "utf8"))
				.trim()
				.split("\n"),
		).toEqual([
			"setup",
			"admin",
			"admin",
			"teardown",
			"setup",
			"customer",
			"customer",
			"teardown",
		]);
		const report = JSON.parse(
			await readFile(join(esm.root, "artifacts", "results.json"), "utf8"),
		) as { config: { workers: number } };
		expect(report.config.workers).toBe(1);
	});

	it.skipIf(process.platform === "win32")(
		"fails fast in the packed CLI and closes every browser descendant",
		async () => {
			const child = spawn(
				installedCliPath(esm.root),
				[
					"run",
					"--role",
					"admin",
					"--role",
					"customer",
					"--grep",
					"fail-fast lane|after failure lane",
				],
				{
					cwd: esm.root,
					env: {
						...process.env,
						NO_COLOR: "1",
						SHOPIFY_E2E_DATA_DIR: esm.dataRoot,
						SHOPIFY_E2E_FAIL_FAST_ACTIVE: "1",
						SHOPIFY_STORE_URL: origin,
						TEMP: esm.runtimeTempRoot,
						TMP: esm.runtimeTempRoot,
						TMPDIR: esm.runtimeTempRoot,
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stderr = "";
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
			});
			const marker = join(esm.root, "admin-fail-fast.marker");
			await expect
				.poll(
					async () =>
						access(marker).then(
							() => true,
							() => false,
						),
					{ interval: 25, timeout: 10_000 },
				)
				.toBe(true);
			const cliPid = child.pid;
			if (cliPid === undefined) throw new Error("Packed CLI did not start");
			const descendants = descendantPids(cliPid);
			expect(descendants.length).toBeGreaterThanOrEqual(2);
			await waitForChildToExit(child, 10_000);
			expect(child.exitCode, stderr).toBe(1);
			expect(stderr).toMatch(/admin: failed[\s\S]*customer: not-run/);
			await expect(
				access(join(esm.root, "customer-after-failure.marker")),
			).rejects.toThrow();
			await Promise.all(
				descendants.map((pid) => waitForProcessToExit(pid, 5_000)),
			);
		},
		20_000,
	);

	it.skipIf(process.platform === "win32")(
		"forwards real SIGTERM through the packed CLI and cleans descendants and context",
		async () => {
			const markerDirectory = await makeTemporaryDirectory(
				"shopify-e2e-installed-signal-",
			);
			const child = spawn(
				installedCliPath(esm.root),
				["run", "--role", "admin", "--grep", "admin interrupt lane"],
				{
					cwd: esm.root,
					detached: true,
					env: {
						...process.env,
						NO_COLOR: "1",
						SHOPIFY_E2E_DATA_DIR: esm.dataRoot,
						SHOPIFY_E2E_INTERRUPT_ACTIVE: "1",
						SHOPIFY_E2E_MARKER_DIR: markerDirectory,
						SHOPIFY_STORE_URL: origin,
						TEMP: esm.runtimeTempRoot,
						TMP: esm.runtimeTempRoot,
						TMPDIR: esm.runtimeTempRoot,
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
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
			const outcome = new Promise<{
				readonly code: number | null;
				readonly signal: NodeJS.Signals | null;
			}>((resolveOutcome, rejectOutcome) => {
				child.once("error", rejectOutcome);
				child.once("exit", (code, signal) => resolveOutcome({ code, signal }));
			});
			let descendants: readonly number[] = [];
			let consumerWebServers: readonly number[] = [];
			let verified = false;

			try {
				const markerPath = join(markerDirectory, "interrupt-started.marker");
				await expect
					.poll(
						async () =>
							access(markerPath).then(
								() => true,
								() => false,
							),
						{ interval: 25, timeout: 10_000 },
					)
					.toBe(true);
				const active = JSON.parse(await readFile(markerPath, "utf8")) as {
					readonly pid: number;
					readonly ppid: number;
				};
				expect(child.pid).toBeTypeOf("number");
				const activeDescendants = descendantPids(child.pid as number);
				consumerWebServers = activeDescendants.filter((pid) =>
					processCommand(pid).includes("web-server.mjs"),
				);
				descendants = activeDescendants.filter(
					(pid) => !consumerWebServers.includes(pid),
				);
				expect(descendants).toEqual(
					expect.arrayContaining([active.pid, active.ppid]),
				);
				signalProcess(child.pid as number, "SIGTERM");

				expect(
					await outcome,
					`interrupted installed CLI\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				).toEqual({ code: 143, signal: null });
				expect(stderr).toContain("Command interrupted by SIGTERM");
				await Promise.all(
					descendants.map((pid) => waitForProcessToExit(pid, 5_000)),
				);
				await Promise.all(
					consumerWebServers.map((pid) => waitForProcessToExit(pid, 5_000)),
				);
				expect(
					(await readdir(esm.runtimeTempRoot)).some((entry) =>
						entry.startsWith("shopify-e2e-context-"),
					),
				).toBe(false);
				verified = true;
			} finally {
				if (!verified) {
					for (const pid of [...descendants, ...consumerWebServers]) {
						signalProcess(pid, "SIGKILL");
					}
					if (
						child.pid &&
						child.exitCode === null &&
						child.signalCode === null
					) {
						child.kill("SIGKILL");
					}
					await Promise.allSettled([
						...[...descendants, ...consumerWebServers].map((pid) =>
							waitForProcessToExit(pid, 1_000),
						),
						waitForChildToExit(child, 1_000),
					]);
				}
			}
		},
		20_000,
	);

	it("lists and removes exactly one packed role state without loading Playwright", () => {
		const list = runCli(esm, ["auth", "list"]);
		expect(list.status, list.stderr).toBe(0);
		expect(list.stdout).toContain("admin\tready");
		expect(list.stdout).toContain("customer\tready");
		const removed = runCli(esm, [
			"auth",
			"remove",
			"--role",
			"customer",
			"--yes",
		]);
		expect(removed.status, removed.stderr).toBe(0);
		const after = runCli(esm, ["auth", "list"]);
		expect(after.stdout).toContain("admin\tready");
		expect(after.stdout).toContain("customer\tmissing");
	});

	it("leaves no package-created execution context after packed runs", async () => {
		const entries = await readdir(esm.runtimeTempRoot);
		expect(
			entries.some((entry) => entry.startsWith("shopify-e2e-context-")),
		).toBe(false);
	});
});
