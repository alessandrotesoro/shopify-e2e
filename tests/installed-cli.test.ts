import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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
	readonly error?: Error;
	readonly status: number | null;
	readonly stderr: string;
	readonly stdout: string;
}

interface RunCommandArgs {
	readonly args: readonly string[];
	readonly command: string;
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly timeoutMs?: number;
}

const runCommand = ({
	args,
	command,
	cwd,
	env,
	timeoutMs,
}: RunCommandArgs): CommandResult => {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: env ?? process.env,
		killSignal: "SIGKILL",
		maxBuffer: 10 * 1024 * 1024,
		timeout: timeoutMs ?? 30_000,
	});
	return {
		...(result.error === undefined ? {} : { error: result.error }),
		status: result.status,
		stderr: result.stderr,
		stdout: result.stdout,
	};
};

interface ExpectSuccessArgs {
	readonly label: string;
	readonly result: CommandResult;
}

const expectSuccess = ({ label, result }: ExpectSuccessArgs): void => {
	expect(
		result.status,
		`${label} failed\nerror: ${result.error?.message ?? "none"}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
	).toBe(0);
};

const makeTemporaryDirectory = async (prefix: string): Promise<string> => {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
};

interface InstallPackageArgs {
	readonly consumerRoot: string;
	readonly hasPlaywright: boolean;
	readonly tarballPath: string;
}

const installPackage = async ({
	consumerRoot,
	hasPlaywright,
	tarballPath,
}: InstallPackageArgs): Promise<void> => {
	const args = [
		"install",
		"--ignore-scripts",
		"--no-audit",
		"--no-fund",
		"--save=false",
		...(hasPlaywright ? [] : ["--omit=peer"]),
		tarballPath,
		...(hasPlaywright ? ["@playwright/test@1.61.1"] : []),
	];
	const result = runCommand({
		args,
		command: npmExecutable,
		cwd: consumerRoot,
		env: {
			...process.env,
			PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
		},
		timeoutMs: 90_000,
	});
	expectSuccess({ label: `install package into ${consumerRoot}`, result });
};

const installedBin = (consumerRoot: string): string => {
	return join(
		consumerRoot,
		"node_modules",
		".bin",
		process.platform === "win32" ? "shopify-e2e.cmd" : "shopify-e2e",
	);
};

interface RunInstalledCliArgs {
	readonly args: readonly string[];
	readonly consumerRoot: string;
	readonly markerDirectory?: string;
}

const runInstalledCli = ({
	args,
	consumerRoot,
	markerDirectory,
}: RunInstalledCliArgs): CommandResult => {
	return runCommand({
		args,
		command: installedBin(consumerRoot),
		cwd: consumerRoot,
		env: {
			...process.env,
			NO_COLOR: "1",
			...(markerDirectory === undefined
				? {}
				: { SHOPIFY_E2E_MARKER_DIR: markerDirectory }),
		},
	});
};

interface MarkerArgs {
	readonly markerDirectory: string;
	readonly name: string;
}

const markerExists = async ({
	markerDirectory,
	name,
}: MarkerArgs): Promise<boolean> => {
	try {
		await access(join(markerDirectory, name));
		return true;
	} catch {
		return false;
	}
};

interface ExpectMarkersAbsentArgs {
	readonly markerDirectory: string;
	readonly names: readonly string[];
}

const expectMarkersAbsent = async ({
	markerDirectory,
	names,
}: ExpectMarkersAbsentArgs): Promise<void> => {
	for (const name of names) {
		await expect(markerExists({ markerDirectory, name }), name).resolves.toBe(
			false,
		);
	}
};

const expectOrdinaryLaneFixturesPresent = async (
	consumerRoot: string,
): Promise<void> => {
	await expect(
		access(join(consumerRoot, "playwright.config.ts")),
	).resolves.toBeUndefined();
	await expect(
		access(join(consumerRoot, "ordinary-e2e", "must-not-load.spec.ts")),
	).resolves.toBeUndefined();
};

const generatedConfigDirectories = async (
	root: string,
): Promise<Set<string>> => {
	const entries = await readdir(root, { withFileTypes: true });
	return new Set(
		entries
			.filter(
				(entry) =>
					entry.isDirectory() && entry.name.startsWith(generatedConfigPrefix),
			)
			.map((entry) => entry.name),
	);
};

interface WaitForMarkerArgs extends MarkerArgs {
	readonly timeoutMs: number;
}

const waitForMarker = async ({
	markerDirectory,
	name,
	timeoutMs,
}: WaitForMarkerArgs): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await markerExists({ markerDirectory, name })) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(`Timed out waiting for marker ${name}`);
};

interface WaitForProcessToExitArgs {
	readonly pid: number;
	readonly timeoutMs: number;
}

const waitForProcessToExit = async ({
	pid,
	timeoutMs,
}: WaitForProcessToExitArgs): Promise<void> => {
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
};

interface WaitForChildToExitArgs {
	readonly child: ChildProcess;
	readonly timeoutMs: number;
}

const waitForChildToExit = async ({
	child,
	timeoutMs,
}: WaitForChildToExitArgs): Promise<void> => {
	if (child.exitCode !== null || child.signalCode !== null) return;

	await new Promise<void>((resolveExit, rejectExit) => {
		const timeout = setTimeout(() => {
			child.off("exit", handleExit);
			rejectExit(
				new Error(`CLI process ${child.pid ?? "unknown"} remained alive`),
			);
		}, timeoutMs);
		const handleExit = (): void => {
			clearTimeout(timeout);
			resolveExit();
		};
		child.once("exit", handleExit);
	});
};

interface SignalProcessArgs {
	readonly pid: number;
	readonly signal: NodeJS.Signals;
}

const signalProcess = ({ pid, signal }: SignalProcessArgs): void => {
	try {
		process.kill(pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
};

interface TerminateAndAwaitProcessesArgs {
	readonly child: ChildProcess;
	readonly descendantPids: readonly number[];
}

const terminateAndAwaitProcesses = async ({
	child,
	descendantPids,
}: TerminateAndAwaitProcessesArgs): Promise<void> => {
	const pids = [...new Set(descendantPids)];
	for (const pid of pids) signalProcess({ pid, signal: "SIGTERM" });
	if (child.pid && child.exitCode === null && child.signalCode === null) {
		signalProcess({ pid: child.pid, signal: "SIGTERM" });
	}

	const exitResults = await Promise.allSettled([
		...pids.map((pid) => waitForProcessToExit({ pid, timeoutMs: 1_000 })),
		waitForChildToExit({ child, timeoutMs: 1_000 }),
	]);
	const lingeringPids = pids.filter(
		(_pid, index) => exitResults[index]?.status === "rejected",
	);
	const shouldForceStopChild = exitResults[pids.length]?.status === "rejected";

	for (const pid of lingeringPids) signalProcess({ pid, signal: "SIGKILL" });
	if (
		shouldForceStopChild &&
		child.pid &&
		child.exitCode === null &&
		child.signalCode === null
	) {
		signalProcess({ pid: child.pid, signal: "SIGKILL" });
	}

	await Promise.all([
		...lingeringPids.map((pid) =>
			waitForProcessToExit({ pid, timeoutMs: 1_000 }),
		),
		...(shouldForceStopChild
			? [waitForChildToExit({ child, timeoutMs: 1_000 })]
			: []),
	]);
};

describe.sequential("installed CLI release boundary", () => {
	let consumerRoot = "";
	let missingPeerConsumerRoot = "";
	let tarballPath = "";

	beforeAll(async () => {
		const packDirectory = await makeTemporaryDirectory("shopify-e2e-pack-");
		const packResult = runCommand({
			args: ["pack", "--json", "--pack-destination", packDirectory],
			command: npmExecutable,
			cwd: projectRoot,
		});
		expectSuccess({ label: "npm pack", result: packResult });
		const packOutput = JSON.parse(packResult.stdout) as Array<{
			readonly filename: string;
		}>;
		tarballPath = join(packDirectory, packOutput[0]?.filename ?? "");
		expect(basename(tarballPath)).toMatch(/^sematico-shopify-e2e-.*\.tgz$/);

		consumerRoot = await makeTemporaryDirectory("shopify-e2e-consumer-");
		await cp(fixtureRoot, consumerRoot, { recursive: true });
		await installPackage({ consumerRoot, hasPlaywright: true, tarballPath });

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
		await installPackage({
			consumerRoot: missingPeerConsumerRoot,
			hasPlaywright: false,
			tarballPath,
		});
	}, 240_000);

	afterAll(async () => {
		await Promise.all(
			temporaryDirectories
				.splice(0)
				.map((directory) => rm(directory, { force: true, recursive: true })),
		);
	});

	it("provides root help, run help, version, and explicit command discovery", () => {
		const deepImport = runCommand({
			args: [
				"--input-type=module",
				"--eval",
				'await import("@sematico/shopify-e2e/dist/errors.js");',
			],
			command: process.execPath,
			cwd: consumerRoot,
		});
		expect(deepImport.status).not.toBe(0);
		expect(deepImport.stderr).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");

		const rootHelp = runInstalledCli({ args: ["--help"], consumerRoot });
		expectSuccess({ label: "installed root help", result: rootHelp });
		expect(rootHelp.stdout).toContain("COMMANDS");
		expect(rootHelp.stdout).toMatch(/\brun\b/);
		expect(rootHelp.stdout).not.toMatch(/\bauth\b|\bsetup\b|\btest\b/);

		const runHelp = runInstalledCli({ args: ["run", "--help"], consumerRoot });
		expectSuccess({ label: "installed run help", result: runHelp });
		expect(runHelp.stdout).toContain("shopify-e2e run");
		expect(runHelp.stdout).toContain("--config");
		expect(runHelp.stdout).toContain("--grep");
		expect(runHelp.stdout).toContain("--grep-invert");

		const version = runInstalledCli({ args: ["--version"], consumerRoot });
		expectSuccess({ label: "installed version", result: version });
		expect(version.stdout).toMatch(/@sematico\/shopify-e2e\/0\.1\.0/);
	});

	it("runs only the conventional two-spec lane in one worker", async () => {
		const markers = await makeTemporaryDirectory("shopify-e2e-markers-");
		const result = runInstalledCli({
			args: ["run"],
			consumerRoot,
			markerDirectory: markers,
		});

		expectSuccess({ label: "installed conventional run", result });
		expect(result.stdout).toMatch(/2 passed/i);
		expect(result.stderr).toContain("shopify-e2e.config.ts");
		expect(result.stderr).toContain("shopify-passing");
		const firstPid = await readFile(join(markers, "first.marker"), "utf8");
		const secondPid = await readFile(join(markers, "second.marker"), "utf8");
		expect(firstPid).toBe(secondPid);
		await expectOrdinaryLaneFixturesPresent(consumerRoot);
		await expectMarkersAbsent({
			markerDirectory: markers,
			names: [
				"alternate.marker",
				"failing.marker",
				"ordinary-config-loaded.marker",
				"ordinary-spec-loaded.marker",
			],
		});
	});

	it("uses --config to run only the alternate Shopify lane", async () => {
		const markers = await makeTemporaryDirectory("shopify-e2e-markers-");
		const result = runInstalledCli({
			args: ["run", "--config", "alternate-shopify-e2e.config.ts"],
			consumerRoot,
			markerDirectory: markers,
		});

		expectSuccess({ label: "installed alternate run", result });
		expect(result.stdout).toMatch(/1 passed/i);
		await expect(
			markerExists({ markerDirectory: markers, name: "alternate.marker" }),
		).resolves.toBe(true);
		await expectOrdinaryLaneFixturesPresent(consumerRoot);
		await expectMarkersAbsent({
			markerDirectory: markers,
			names: [
				"first.marker",
				"second.marker",
				"failing.marker",
				"ordinary-config-loaded.marker",
				"ordinary-spec-loaded.marker",
			],
		});
	});

	it("fails preflight without the consumer-owned optional peer", async () => {
		const markers = await makeTemporaryDirectory("shopify-e2e-markers-");
		const result = runInstalledCli({
			args: ["run"],
			consumerRoot: missingPeerConsumerRoot,
			markerDirectory: markers,
		});

		expect(result.status).toBe(2);
		expect(result.stderr).toMatch(
			/consumer project must install compatible @playwright\/test/i,
		);
		await expectMarkersAbsent({
			markerDirectory: markers,
			names: ["first.marker", "second.marker"],
		});
	});

	it("force-stops a hung release-gate subprocess at its deadline", () => {
		const startedAt = Date.now();
		const result = runCommand({
			args: ["--input-type=module", "--eval", "setInterval(() => {}, 1_000);"],
			command: process.execPath,
			cwd: projectRoot,
			timeoutMs: 100,
		});

		expect(result.status).toBeNull();
		expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe(
			"ETIMEDOUT",
		);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	it("preserves the failing Shopify lane result without touching other lanes", async () => {
		const markers = await makeTemporaryDirectory("shopify-e2e-markers-");
		const result = runInstalledCli({
			args: ["run", "--config", "failing-shopify-e2e.config.ts"],
			consumerRoot,
			markerDirectory: markers,
		});

		expect(result.status).toBe(1);
		expect(result.stdout).toMatch(/1 failed/i);
		await expect(
			markerExists({ markerDirectory: markers, name: "failing.marker" }),
		).resolves.toBe(true);
		await expectOrdinaryLaneFixturesPresent(consumerRoot);
		await expectMarkersAbsent({
			markerDirectory: markers,
			names: [
				"first.marker",
				"second.marker",
				"alternate.marker",
				"ordinary-config-loaded.marker",
				"ordinary-spec-loaded.marker",
			],
		});
	});

	it.skipIf(process.platform === "win32")(
		"forwards a real SIGTERM, returns 143, and cleans the generated config and child tree",
		async () => {
			const markers = await makeTemporaryDirectory("shopify-e2e-markers-");
			const runtimeTemp = await makeTemporaryDirectory("shopify-e2e-runtime-");
			const generatedBefore = await generatedConfigDirectories(runtimeTemp);
			const child = spawn(installedBin(consumerRoot), ["run"], {
				cwd: consumerRoot,
				detached: true,
				env: {
					...process.env,
					NO_COLOR: "1",
					SHOPIFY_E2E_INTERRUPT_ACTIVE: "1",
					SHOPIFY_E2E_MARKER_DIR: markers,
					TEMP: runtimeTemp,
					TMP: runtimeTemp,
					TMPDIR: runtimeTemp,
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
			let isCleanupVerified = false;

			try {
				await waitForMarker({
					markerDirectory: markers,
					name: "interrupt-started.marker",
					timeoutMs: 10_000,
				});
				interruptedProcess = JSON.parse(
					await readFile(join(markers, "interrupt-started.marker"), "utf8"),
				) as { readonly pid: number; readonly ppid: number };
				expect(child.pid).toBeTypeOf("number");
				const outcomePromise = new Promise<{
					readonly code: number | null;
					readonly signal: NodeJS.Signals | null;
				}>((resolveOutcome, rejectOutcome) => {
					child.once("error", rejectOutcome);
					child.once("exit", (code, signal) =>
						resolveOutcome({ code, signal }),
					);
				});
				process.kill(child.pid as number, "SIGTERM");
				const outcome = await outcomePromise;

				expect(
					outcome,
					`interrupted installed CLI\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				).toEqual({ code: 143, signal: null });
				await waitForProcessToExit({
					pid: interruptedProcess.pid,
					timeoutMs: 5_000,
				});
				await waitForProcessToExit({
					pid: interruptedProcess.ppid,
					timeoutMs: 5_000,
				});
				expect(await generatedConfigDirectories(runtimeTemp)).toEqual(
					generatedBefore,
				);
				isCleanupVerified = true;
			} finally {
				if (!isCleanupVerified) {
					await terminateAndAwaitProcesses({
						child,
						descendantPids: interruptedProcess
							? [interruptedProcess.pid, interruptedProcess.ppid]
							: [],
					});
				}
			}
		},
		20_000,
	);
});
