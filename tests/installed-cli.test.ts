import { spawn, spawnSync } from "node:child_process";
import {
	access,
	cp,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");
const fixtureRoot = resolve(import.meta.dirname, "fixtures/consumer");
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const generatedConfigPrefix = "shopify-e2e-playwright-";
const temporaryDirectories: string[] = [];

interface CommandResult {
	readonly status: number | null;
	readonly stderr: string;
	readonly stdout: string;
}

function runCommand(
	command: string,
	args: readonly string[],
	options: {
		readonly cwd: string;
		readonly env?: NodeJS.ProcessEnv;
	},
): CommandResult {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: options.env ?? process.env,
		maxBuffer: 10 * 1024 * 1024,
	});
	return {
		status: result.status,
		stderr: result.stderr,
		stdout: result.stdout,
	};
}

function expectSuccess(result: CommandResult, label: string): void {
	expect(
		result.status,
		`${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
	).toBe(0);
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

async function installPackage(
	consumerRoot: string,
	tarballPath: string,
	withPlaywright: boolean,
): Promise<void> {
	const args = [
		"install",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		"--save=false",
		...(withPlaywright ? [] : ["--omit=peer"]),
		tarballPath,
		...(withPlaywright ? ["@playwright/test@1.61.1"] : []),
	];
	const result = runCommand(npmExecutable, args, {
		cwd: consumerRoot,
		env: {
			...process.env,
			PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
		},
	});
	expectSuccess(result, `install package into ${consumerRoot}`);
}

function installedBin(consumerRoot: string): string {
	return join(
		consumerRoot,
		"node_modules",
		".bin",
		process.platform === "win32" ? "shopify-e2e.cmd" : "shopify-e2e",
	);
}

function runInstalledCli(
	consumerRoot: string,
	args: readonly string[],
	markerDirectory?: string,
): CommandResult {
	return runCommand(installedBin(consumerRoot), args, {
		cwd: consumerRoot,
		env: {
			...process.env,
			NO_COLOR: "1",
			...(markerDirectory === undefined
				? {}
				: { SHOPIFY_E2E_MARKER_DIR: markerDirectory }),
		},
	});
}

async function markerExists(
	markerDirectory: string,
	name: string,
): Promise<boolean> {
	try {
		await access(join(markerDirectory, name));
		return true;
	} catch {
		return false;
	}
}

async function expectMarkersAbsent(
	markerDirectory: string,
	names: readonly string[],
): Promise<void> {
	for (const name of names) {
		await expect(markerExists(markerDirectory, name), name).resolves.toBe(
			false,
		);
	}
}

async function generatedConfigDirectories(): Promise<Set<string>> {
	const entries = await readdir(tmpdir(), { withFileTypes: true });
	return new Set(
		entries
			.filter(
				(entry) =>
					entry.isDirectory() && entry.name.startsWith(generatedConfigPrefix),
			)
			.map((entry) => entry.name),
	);
}

async function waitForMarker(
	markerDirectory: string,
	name: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await markerExists(markerDirectory, name)) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(`Timed out waiting for marker ${name}`);
}

async function waitForProcessToExit(
	pid: number,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(`Process ${pid} remained alive after CLI exit`);
}

describe.sequential("installed CLI release boundary", () => {
	let consumerRoot = "";
	let missingPeerConsumerRoot = "";
	let tarballPath = "";

	beforeAll(async () => {
		const buildResult = runCommand(npmExecutable, ["run", "build"], {
			cwd: projectRoot,
		});
		expectSuccess(buildResult, "clean package build");

		const packDirectory = await makeTemporaryDirectory("shopify-e2e-pack-");
		const packResult = runCommand(
			npmExecutable,
			["pack", "--json", "--pack-destination", packDirectory],
			{ cwd: projectRoot },
		);
		expectSuccess(packResult, "npm pack");
		const packOutput = JSON.parse(packResult.stdout) as Array<{
			readonly filename: string;
		}>;
		tarballPath = join(packDirectory, packOutput[0]?.filename ?? "");
		expect(basename(tarballPath)).toMatch(/^sematico-shopify-e2e-.*\.tgz$/);

		consumerRoot = await makeTemporaryDirectory("shopify-e2e-consumer-");
		await cp(fixtureRoot, consumerRoot, { recursive: true });
		await installPackage(consumerRoot, tarballPath, true);

		missingPeerConsumerRoot = await makeTemporaryDirectory(
			"shopify-e2e-missing-peer-",
		);
		await writeFile(
			join(missingPeerConsumerRoot, "package.json"),
			'{"name":"missing-peer-consumer","private":true,"type":"module"}\n',
		);
		await cp(
			join(fixtureRoot, "shopify-e2e.config.ts"),
			join(missingPeerConsumerRoot, "shopify-e2e.config.ts"),
		);
		await cp(
			join(fixtureRoot, "shopify-passing"),
			join(missingPeerConsumerRoot, "shopify-passing"),
			{ recursive: true },
		);
		await installPackage(missingPeerConsumerRoot, tarballPath, false);
	}, 120_000);

	afterAll(async () => {
		await Promise.all(
			temporaryDirectories
				.splice(0)
				.map((directory) => rm(directory, { force: true, recursive: true })),
		);
	});

	it("provides root help, run help, version, and explicit command discovery", () => {
		const rootHelp = runInstalledCli(consumerRoot, ["--help"]);
		expectSuccess(rootHelp, "installed root help");
		expect(rootHelp.stdout).toContain("COMMANDS");
		expect(rootHelp.stdout).toMatch(/\brun\b/);
		expect(rootHelp.stdout).not.toMatch(/\bauth\b|\bsetup\b|\btest\b/);

		const runHelp = runInstalledCli(consumerRoot, ["run", "--help"]);
		expectSuccess(runHelp, "installed run help");
		expect(runHelp.stdout).toContain("shopify-e2e run");
		expect(runHelp.stdout).toContain("--config");
		expect(runHelp.stdout).toContain("--grep");
		expect(runHelp.stdout).toContain("--grep-invert");

		const version = runInstalledCli(consumerRoot, ["--version"]);
		expectSuccess(version, "installed version");
		expect(version.stdout).toMatch(/@sematico\/shopify-e2e\/0\.1\.0/);
	});

	it("runs only the conventional two-spec lane in one worker", async () => {
		const markers = await makeTemporaryDirectory("shopify-e2e-markers-");
		const result = runInstalledCli(consumerRoot, ["run"], markers);

		expectSuccess(result, "installed conventional run");
		expect(result.stdout).toMatch(/2 passed/i);
		expect(result.stderr).toContain("shopify-e2e.config.ts");
		expect(result.stderr).toContain("shopify-passing");
		const firstPid = await readFile(join(markers, "first.marker"), "utf8");
		const secondPid = await readFile(join(markers, "second.marker"), "utf8");
		expect(firstPid).toBe(secondPid);
		await expectMarkersAbsent(markers, [
			"alternate.marker",
			"failing.marker",
			"ordinary-config-loaded.marker",
			"ordinary-spec-loaded.marker",
		]);
	});

	it("uses --config to run only the alternate Shopify lane", async () => {
		const markers = await makeTemporaryDirectory("shopify-e2e-markers-");
		const result = runInstalledCli(
			consumerRoot,
			["run", "--config", "alternate-shopify-e2e.config.ts"],
			markers,
		);

		expectSuccess(result, "installed alternate run");
		expect(result.stdout).toMatch(/1 passed/i);
		await expect(markerExists(markers, "alternate.marker")).resolves.toBe(true);
		await expectMarkersAbsent(markers, [
			"first.marker",
			"second.marker",
			"failing.marker",
			"ordinary-config-loaded.marker",
			"ordinary-spec-loaded.marker",
		]);
	});

	it("fails preflight without the consumer-owned optional peer", async () => {
		const markers = await makeTemporaryDirectory("shopify-e2e-markers-");
		const result = runInstalledCli(missingPeerConsumerRoot, ["run"], markers);

		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(
			/consumer project must install compatible @playwright\/test/i,
		);
		await expectMarkersAbsent(markers, [
			"first.marker",
			"second.marker",
			"ordinary-config-loaded.marker",
			"ordinary-spec-loaded.marker",
		]);
	});

	it("preserves the failing Shopify lane result without touching other lanes", async () => {
		const markers = await makeTemporaryDirectory("shopify-e2e-markers-");
		const result = runInstalledCli(
			consumerRoot,
			["run", "--config", "failing-shopify-e2e.config.ts"],
			markers,
		);

		expect(result.status).toBe(1);
		expect(result.stdout).toMatch(/1 failed/i);
		await expect(markerExists(markers, "failing.marker")).resolves.toBe(true);
		await expectMarkersAbsent(markers, [
			"first.marker",
			"second.marker",
			"alternate.marker",
			"ordinary-config-loaded.marker",
			"ordinary-spec-loaded.marker",
		]);
	});

	it.skipIf(process.platform === "win32")(
		"forwards a real SIGTERM, returns 143, and cleans the generated config and child tree",
		async () => {
			const markers = await makeTemporaryDirectory("shopify-e2e-markers-");
			const generatedBefore = await generatedConfigDirectories();
			const child = spawn(installedBin(consumerRoot), ["run"], {
				cwd: consumerRoot,
				detached: true,
				env: {
					...process.env,
					NO_COLOR: "1",
					SHOPIFY_E2E_INTERRUPT_ACTIVE: "1",
					SHOPIFY_E2E_MARKER_DIR: markers,
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
			let interruptedProcess:
				| { readonly pid: number; readonly ppid: number }
				| undefined;
			let cleanupVerified = false;

			try {
				await waitForMarker(markers, "interrupt-started.marker", 10_000);
				expect(child.pid).toBeTypeOf("number");
				process.kill(child.pid as number, "SIGTERM");
				const outcome = await new Promise<{
					readonly code: number | null;
					readonly signal: NodeJS.Signals | null;
				}>((resolveOutcome, rejectOutcome) => {
					child.once("error", rejectOutcome);
					child.once("exit", (code, signal) =>
						resolveOutcome({ code, signal }),
					);
				});

				expect(
					outcome,
					`interrupted installed CLI\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				).toEqual({ code: 143, signal: null });
				interruptedProcess = JSON.parse(
					await readFile(join(markers, "interrupt-started.marker"), "utf8"),
				) as { readonly pid: number; readonly ppid: number };
				await waitForProcessToExit(interruptedProcess.pid, 5_000);
				await waitForProcessToExit(interruptedProcess.ppid, 5_000);
				expect(await generatedConfigDirectories()).toEqual(generatedBefore);
				cleanupVerified = true;
			} finally {
				if (!cleanupVerified) {
					if (
						child.pid &&
						child.exitCode === null &&
						child.signalCode === null
					) {
						try {
							process.kill(child.pid, "SIGTERM");
						} catch {}
						await Promise.race([
							new Promise<void>((resolveExit) => {
								child.once("exit", () => resolveExit());
							}),
							new Promise<void>((resolveDelay) =>
								setTimeout(resolveDelay, 1_000),
							),
						]);
						if (child.exitCode === null && child.signalCode === null) {
							try {
								process.kill(child.pid, "SIGKILL");
							} catch {}
						}
					}
					for (const pid of interruptedProcess
						? [interruptedProcess.pid, interruptedProcess.ppid]
						: []) {
						try {
							process.kill(pid, "SIGKILL");
						} catch {}
					}
				}
			}
		},
		20_000,
	);
});
