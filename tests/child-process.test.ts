import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ShopifyE2EInfrastructureError } from "../src/errors.js";
import {
	type ChildProcessRuntime,
	runChild,
} from "../src/process/run-child.js";

class FakeChild extends EventEmitter {
	public readonly pid = 4242;
	public kill = vi.fn(() => true);
}

interface FakeRuntime {
	readonly child: FakeChild;
	readonly forwarded: Array<{ pid: number; signal: NodeJS.Signals }>;
	readonly listeners: Map<NodeJS.Signals, Set<() => void>>;
	readonly runtime: ChildProcessRuntime;
}

function makeRuntime(platform: NodeJS.Platform = "linux"): FakeRuntime {
	const child = new FakeChild();
	const forwarded: Array<{ pid: number; signal: NodeJS.Signals }> = [];
	const listeners = new Map<NodeJS.Signals, Set<() => void>>();
	const runtime: ChildProcessRuntime = {
		addSignalListener(signal, listener) {
			const signalListeners = listeners.get(signal) ?? new Set();
			signalListeners.add(listener);
			listeners.set(signal, signalListeners);
		},
		forwardSignal: vi.fn((pid, signal) => {
			forwarded.push({ pid, signal });
			return true;
		}),
		platform,
		removeSignalListener(signal, listener) {
			listeners.get(signal)?.delete(listener);
		},
		spawn: vi.fn(() => child as never),
	};
	return { child, forwarded, listeners, runtime };
}

function emitSignal(fake: FakeRuntime, signal: NodeJS.Signals): void {
	for (const listener of fake.listeners.get(signal) ?? []) listener();
}

const invocation = {
	args: ["/consumer/@playwright/test/cli.js", "test", "--workers=1"],
	executable: process.execPath,
} as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("Playwright child lifecycle", () => {
	it("spawns Node once with inherited stdio, no shell, and a POSIX process group", async () => {
		const fake = makeRuntime();
		const resultPromise = runChild(invocation, fake.runtime);

		expect(fake.runtime.spawn).toHaveBeenCalledWith(
			process.execPath,
			invocation.args,
			{
				detached: true,
				shell: false,
				stdio: "inherit",
			},
		);
		fake.child.emit("exit", 0, null);

		await expect(resultPromise).resolves.toBe(0);
	});

	it.each([0, 1, 17])("preserves numeric child exit %i", async (exitCode) => {
		const fake = makeRuntime();
		const resultPromise = runChild(invocation, fake.runtime);

		fake.child.emit("exit", exitCode, null);

		await expect(resultPromise).resolves.toBe(exitCode);
		for (const listeners of fake.listeners.values()) {
			expect(listeners).toHaveLength(0);
		}
	});

	it.each([
		{ expected: 130, signal: "SIGINT" },
		{ expected: 143, signal: "SIGTERM" },
	] as const)("forwards $signal once to the POSIX child group and maps its outcome", async ({
		expected,
		signal,
	}) => {
		const fake = makeRuntime();
		const resultPromise = runChild(invocation, fake.runtime);

		emitSignal(fake, signal);
		emitSignal(fake, signal);
		expect(fake.forwarded).toEqual([{ pid: -fake.child.pid, signal }]);
		fake.child.emit("exit", null, signal);

		await expect(resultPromise).resolves.toBe(expected);
		for (const listeners of fake.listeners.values()) {
			expect(listeners).toHaveLength(0);
		}
	});

	it("uses the supported child signal seam instead of negative pids off POSIX", async () => {
		const fake = makeRuntime("win32");
		const resultPromise = runChild(invocation, fake.runtime);

		emitSignal(fake, "SIGINT");
		emitSignal(fake, "SIGINT");
		expect(fake.forwarded).toEqual([]);
		expect(fake.child.kill).toHaveBeenCalledTimes(1);
		expect(fake.child.kill).toHaveBeenCalledWith("SIGINT");
		fake.child.emit("exit", null, "SIGINT");

		await expect(resultPromise).resolves.toBe(130);
	});

	it("force-terminates the POSIX child group and retains a forwarding error when delivery throws", async () => {
		const fake = makeRuntime();
		vi.mocked(fake.runtime.forwardSignal).mockImplementationOnce(() => {
			throw new Error("signal delivery failed");
		});
		const resultPromise = runChild(invocation, fake.runtime);
		let settlements = 0;
		void resultPromise.then(
			() => {
				settlements += 1;
			},
			() => {
				settlements += 1;
			},
		);

		emitSignal(fake, "SIGTERM");
		await Promise.resolve();

		expect(fake.forwarded).toEqual([
			{ pid: -fake.child.pid, signal: "SIGKILL" },
		]);
		expect(fake.child.kill).not.toHaveBeenCalled();
		expect(settlements).toBe(0);
		fake.child.emit("exit", null, "SIGKILL");

		await expect(resultPromise).rejects.toThrow(/Could not forward SIGTERM/);
		expect(settlements).toBe(1);
		for (const listeners of fake.listeners.values()) {
			expect(listeners).toHaveLength(0);
		}

		fake.child.emit("exit", 0, null);
		fake.child.emit("error", new Error("late error"));
		await Promise.resolve();
		expect(settlements).toBe(1);
	});

	it("force-terminates the direct child off POSIX when signal delivery returns false", async () => {
		const fake = makeRuntime("win32");
		fake.child.kill.mockReturnValueOnce(false).mockReturnValueOnce(true);
		const resultPromise = runChild(invocation, fake.runtime);
		let settlements = 0;
		void resultPromise.then(
			() => {
				settlements += 1;
			},
			() => {
				settlements += 1;
			},
		);

		emitSignal(fake, "SIGINT");
		await Promise.resolve();

		expect(fake.forwarded).toEqual([]);
		expect(fake.child.kill).toHaveBeenNthCalledWith(1, "SIGINT");
		expect(fake.child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
		expect(settlements).toBe(0);
		fake.child.emit("exit", null, "SIGKILL");

		await expect(resultPromise).rejects.toThrow(/Could not forward SIGINT/);
		expect(settlements).toBe(1);
		for (const listeners of fake.listeners.values()) {
			expect(listeners).toHaveLength(0);
		}
	});

	it("settles the retained forwarding error when recovery emits error without exit", async () => {
		const fake = makeRuntime();
		vi.mocked(fake.runtime.forwardSignal).mockImplementationOnce(() => {
			throw new Error("signal delivery failed");
		});
		const resultPromise = runChild(invocation, fake.runtime);

		emitSignal(fake, "SIGTERM");
		expect(fake.forwarded).toEqual([
			{ pid: -fake.child.pid, signal: "SIGKILL" },
		]);
		fake.child.emit("error", new Error("kill failed after delivery"));

		await expect(resultPromise).rejects.toThrow(/Could not forward SIGTERM/);
		for (const listeners of fake.listeners.values()) {
			expect(listeners).toHaveLength(0);
		}
	});

	it("turns a spawn error into a secret-safe infrastructure failure and settles once", async () => {
		const fake = makeRuntime();
		const resultPromise = runChild(invocation, fake.runtime);

		fake.child.emit("error", new Error("spawn EACCES TOKEN=secret"));
		fake.child.emit("exit", 0, null);

		const error = await resultPromise.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ShopifyE2EInfrastructureError);
		expect((error as ShopifyE2EInfrastructureError).exitCode).toBe(1);
		expect((error as Error).message).toContain(process.execPath);
		expect((error as Error).message).not.toContain("TOKEN=secret");
		for (const listeners of fake.listeners.values()) {
			expect(listeners).toHaveLength(0);
		}
	});

	it("treats an indeterminate child completion as package infrastructure failure", async () => {
		const fake = makeRuntime();
		const resultPromise = runChild(invocation, fake.runtime);

		fake.child.emit("exit", null, null);

		await expect(resultPromise).rejects.toThrow(/outcome/i);
	});
});

const posixTest = process.platform === "win32" ? it.skip : it;

posixTest(
	"forwards one real process-group SIGTERM and exits 143",
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
const code = await runChild({ executable: process.execPath, args: [${JSON.stringify(childPath)}] });
process.exit(code);
`;
		const { spawn } = await import("node:child_process");
		const helper = spawn(
			process.execPath,
			["--input-type=module", "--eval", helperSource],
			{
				detached: true,
				stdio: "ignore",
			},
		);
		const helperPid = helper.pid;
		if (helperPid === undefined) {
			throw new Error("signal-test helper did not start");
		}

		try {
			await expect
				.poll(async () =>
					access(readyPath)
						.then(() => true)
						.catch(() => false),
				)
				.toBe(true);
			process.kill(-helperPid, "SIGTERM");
			const outcome = await new Promise<{
				readonly code: number | null;
				readonly signal: NodeJS.Signals | null;
			}>((resolveOutcome) => {
				helper.once("exit", (code, signal) => resolveOutcome({ code, signal }));
			});

			expect(outcome).toEqual({ code: 143, signal: null });
			expect(await readFile(signalLogPath, "utf8")).toBe("SIGTERM\n");
		} finally {
			if (helper.pid) {
				try {
					process.kill(-helper.pid, "SIGKILL");
				} catch {}
			}
		}
	},
	15_000,
);
