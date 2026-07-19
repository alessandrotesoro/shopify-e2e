import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ShopifyE2EInfrastructureError } from "../src/errors.js";
import { CommandSignalError } from "../src/process/command-signals.js";
import {
	type ChildProcessRuntime,
	runChild,
} from "../src/process/run-child.js";

class FakeChild extends EventEmitter {
	public readonly pid = 4242;
	public kill = vi.fn(() => true);
}

const makeRuntime = (platform: NodeJS.Platform = "linux") => {
	const child = new FakeChild();
	const forwarded: Array<{ pid: number; signal: NodeJS.Signals }> = [];
	const runtime: ChildProcessRuntime = {
		forwardSignal: vi.fn(({ pid, signal }) => {
			forwarded.push({ pid, signal });
			return true;
		}),
		platform,
		spawn: vi.fn(() => child as never),
	};
	return { child, forwarded, runtime };
};

const invocation = {
	args: ["/consumer/@playwright/test/cli.js", "test", "--workers=1"],
	environment: {
		PATH: "/usr/bin",
		SHOPIFY_E2E_EXECUTION_CONTEXT: "/tmp/context.json",
	},
	executable: process.execPath,
} as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("Playwright child lifecycle", () => {
	it("spawns once with inherited stdio, no shell, and a POSIX process group", async () => {
		const fake = makeRuntime();
		const result = runChild({ invocation, runtime: fake.runtime });
		expect(fake.runtime.spawn).toHaveBeenCalledWith(
			process.execPath,
			invocation.args,
			{
				detached: true,
				env: invocation.environment,
				shell: false,
				stdio: "inherit",
			},
		);
		fake.child.emit("exit", 0, null);
		await expect(result).resolves.toBe(0);
	});

	it.each([0, 1, 17])("preserves numeric child exit %i", async (exitCode) => {
		const fake = makeRuntime();
		const result = runChild({ invocation, runtime: fake.runtime });
		fake.child.emit("exit", exitCode, null);
		await expect(result).resolves.toBe(exitCode);
	});

	it.each([
		{ expected: 130, reason: "SIGINT", signal: "SIGINT" },
		{ expected: 143, reason: "SIGTERM", signal: "SIGTERM" },
	] as const)("uses the command abort signal as the sole $signal authority", async ({
		expected,
		reason,
		signal,
	}) => {
		const fake = makeRuntime();
		const controller = new AbortController();
		const result = runChild({
			invocation,
			runtime: fake.runtime,
			signal: controller.signal,
		});
		controller.abort(reason);
		controller.abort(reason);
		expect(fake.forwarded).toEqual([{ pid: -fake.child.pid, signal }]);
		fake.child.emit("exit", null, signal);
		await expect(result).rejects.toMatchObject({
			exitCode: expected,
			signal,
		});
	});

	it("uses direct-child signaling off POSIX", async () => {
		const fake = makeRuntime("win32");
		const controller = new AbortController();
		const result = runChild({
			invocation,
			runtime: fake.runtime,
			signal: controller.signal,
		});
		controller.abort("SIGINT");
		expect(fake.forwarded).toEqual([]);
		expect(fake.child.kill).toHaveBeenCalledWith("SIGINT");
		fake.child.emit("exit", null, "SIGINT");
		await expect(result).rejects.toBeInstanceOf(CommandSignalError);
	});

	it("falls back to the direct child when process-group delivery fails", async () => {
		const fake = makeRuntime();
		vi.mocked(fake.runtime.forwardSignal).mockReturnValue(false);
		const controller = new AbortController();
		const result = runChild({
			invocation,
			runtime: fake.runtime,
			signal: controller.signal,
		});
		controller.abort("SIGTERM");
		expect(fake.child.kill).toHaveBeenCalledWith("SIGTERM");
		fake.child.emit("exit", null, "SIGTERM");
		await expect(result).rejects.toMatchObject({ exitCode: 143 });
	});

	it("escalates an unsettled child to SIGKILL after the grace period", async () => {
		vi.useFakeTimers();
		const fake = makeRuntime();
		const controller = new AbortController();
		const result = runChild({
			invocation,
			runtime: fake.runtime,
			signal: controller.signal,
			terminationGraceMs: 10,
		});
		controller.abort("SIGTERM");
		await vi.advanceTimersByTimeAsync(10);
		expect(fake.forwarded).toEqual([
			{ pid: -fake.child.pid, signal: "SIGTERM" },
			{ pid: -fake.child.pid, signal: "SIGKILL" },
		]);
		fake.child.emit("exit", null, "SIGKILL");
		await expect(result).rejects.toMatchObject({ exitCode: 143 });
	});

	it("uses an infrastructure abort reason for unexpected browser death", async () => {
		const fake = makeRuntime();
		const controller = new AbortController();
		const failure = new ShopifyE2EInfrastructureError(
			"Consumer Chromium server closed unexpectedly",
		);
		const result = runChild({
			invocation,
			runtime: fake.runtime,
			signal: controller.signal,
		});
		controller.abort(failure);
		fake.child.emit("exit", null, "SIGTERM");
		await expect(result).rejects.toBe(failure);
	});

	it("turns spawn errors into secret-safe infrastructure failures", async () => {
		const fake = makeRuntime();
		const result = runChild({ invocation, runtime: fake.runtime });
		fake.child.emit("error", new Error("spawn EACCES TOKEN=secret"));
		const error = await result.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ShopifyE2EInfrastructureError);
		expect(String(error)).toContain(process.execPath);
		expect(String(error)).not.toContain("TOKEN=secret");
	});

	it("treats an indeterminate completion as infrastructure failure", async () => {
		const fake = makeRuntime();
		const result = runChild({ invocation, runtime: fake.runtime });
		fake.child.emit("exit", null, null);
		await expect(result).rejects.toThrow(/outcome/i);
	});
});

const posixTest = process.platform === "win32" ? it.skip : it;

posixTest(
	"forwards one real process-group SIGTERM and rejects with 143",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "shopify-e2e-signal-"));
		temporaryDirectories.push(directory);
		const readyPath = join(directory, "ready");
		const signalLogPath = join(directory, "signals");
		const childPath = join(directory, "child.mjs");
		await writeFile(
			childPath,
			`import { appendFileSync, writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  appendFileSync(${JSON.stringify(signalLogPath)}, "SIGTERM\\n");
  process.removeAllListeners("SIGTERM");
  process.kill(process.pid, "SIGTERM");
});
writeFileSync(${JSON.stringify(readyPath)}, "ready");
setInterval(() => {}, 1000);
`,
		);

		const builtModuleUrl = pathToFileURL(
			resolve(import.meta.dirname, "../dist/process/run-child.js"),
		).href;
		const helperSource = `import { runChild } from ${JSON.stringify(builtModuleUrl)};
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort("SIGTERM"));
try {
  await runChild({ invocation: { executable: process.execPath, args: [${JSON.stringify(childPath)}] }, signal: controller.signal });
} catch (error) {
  process.exit(error.exitCode ?? 1);
}
`;
		const { spawn } = await import("node:child_process");
		const helper = spawn(
			process.execPath,
			["--input-type=module", "--eval", helperSource],
			{ detached: true, stdio: "ignore" },
		);
		const helperPid = helper.pid;
		if (helperPid === undefined) throw new Error("signal helper did not start");
		let exited = false;
		try {
			await expect
				.poll(async () =>
					access(readyPath)
						.then(() => true)
						.catch(() => false),
				)
				.toBe(true);
			process.kill(helperPid, "SIGTERM");
			const outcome = await new Promise<{
				readonly code: number | null;
				readonly signal: NodeJS.Signals | null;
			}>((resolveOutcome) => {
				helper.once("exit", (code, signal) => resolveOutcome({ code, signal }));
			});
			exited = true;
			expect(outcome).toEqual({ code: 143, signal: null });
			expect(await readFile(signalLogPath, "utf8")).toBe("SIGTERM\n");
		} finally {
			if (!exited && helper.pid) {
				try {
					process.kill(-helper.pid, "SIGKILL");
				} catch {
					// The helper may already be gone.
				}
			}
		}
	},
	15_000,
);
