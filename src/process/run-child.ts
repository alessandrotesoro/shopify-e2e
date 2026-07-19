import { spawn } from "node:child_process";
import { constants } from "node:os";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { PLAYWRIGHT_WS_ENDPOINT_ENV } from "../config/execution-environment.cjs";
import { ShopifyE2EInfrastructureError } from "../errors.js";
import type { PlaywrightInvocation } from "../playwright/invocation.js";
import { errorFromAbortSignal } from "./command-signals.js";

type ChildSignal = "SIGINT" | "SIGKILL" | "SIGTERM";
type ChildOutcome = { error: Error } | { exitCode: number };

export interface ForwardSignalArgs {
	readonly pid: number;
	readonly signal: ChildSignal;
}

export interface ChildProcessRuntime {
	readonly forwardSignal: (args: ForwardSignalArgs) => boolean;
	readonly platform: NodeJS.Platform;
	readonly spawn: typeof spawn;
	readonly stderr: NodeJS.WritableStream;
}

const defaultRuntime: ChildProcessRuntime = {
	forwardSignal: ({ pid, signal }) => process.kill(pid, signal),
	platform: process.platform,
	spawn,
	stderr: process.stderr,
};

const REDACTED_BROWSER_ENDPOINT = "[REDACTED PLAYWRIGHT ENDPOINT]";

const redactBrowserEndpoint = (endpoint: string): Transform => {
	const decoder = new StringDecoder("utf8");
	let pending = "";
	const replaceEndpoint = (value: string): string =>
		value.replaceAll(endpoint, REDACTED_BROWSER_ENDPOINT);
	return new Transform({
		flush(callback) {
			this.push(replaceEndpoint(pending + decoder.end()));
			callback();
		},
		transform(chunk: Buffer, _encoding, callback) {
			pending = replaceEndpoint(pending + decoder.write(chunk));
			const retainedLength = Math.max(endpoint.length - 1, 0);
			const emittedLength = Math.max(pending.length - retainedLength, 0);
			if (emittedLength > 0) {
				this.push(pending.slice(0, emittedLength));
				pending = pending.slice(emittedLength);
			}
			callback();
		},
	});
};

const isPosix = (platform: NodeJS.Platform): boolean => platform !== "win32";

const signalExitCode = (signal: NodeJS.Signals): number | undefined => {
	const signalNumber = constants.signals[signal];
	return typeof signalNumber === "number" ? 128 + signalNumber : undefined;
};

const playwrightAbortSignal = (signal: AbortSignal): "SIGINT" | "SIGTERM" =>
	signal.reason === "SIGINT" || signal.reason === "SIGTERM"
		? "SIGINT"
		: "SIGTERM";

export interface RunChildArgs {
	readonly invocation: PlaywrightInvocation;
	readonly runtime?: ChildProcessRuntime;
	readonly signal?: AbortSignal;
	readonly terminationGraceMs?: number;
}

export const runChild = async ({
	invocation,
	runtime = defaultRuntime,
	signal,
	terminationGraceMs = 10_000,
}: RunChildArgs): Promise<number> => {
	const isPosixPlatform = isPosix(runtime.platform);
	const browserEndpoint = invocation.environment?.[PLAYWRIGHT_WS_ENDPOINT_ENV];
	const child = runtime.spawn(invocation.executable, invocation.args, {
		detached: isPosixPlatform,
		...(invocation.environment === undefined
			? {}
			: { env: invocation.environment }),
		shell: false,
		stdio:
			typeof browserEndpoint === "string"
				? ["inherit", "inherit", "pipe"]
				: "inherit",
	});
	if (typeof browserEndpoint === "string" && child.stderr) {
		child.stderr
			.pipe(redactBrowserEndpoint(browserEndpoint))
			.pipe(runtime.stderr, { end: false });
	}

	return new Promise<number>((resolve, reject) => {
		let isSettled = false;
		let interruption: Error | undefined;
		let graceTimer: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;

		const clearTimers = (): void => {
			if (graceTimer) clearTimeout(graceTimer);
			if (killTimer) clearTimeout(killTimer);
		};
		const removeAbortListener = (): void => {
			signal?.removeEventListener("abort", onAbort);
		};
		const settle = (outcome: ChildOutcome): void => {
			if (isSettled) return;
			isSettled = true;
			clearTimers();
			removeAbortListener();
			if ("error" in outcome) reject(outcome.error);
			else resolve(outcome.exitCode);
		};
		const deliver = (selectedSignal: ChildSignal): boolean => {
			if (isPosixPlatform && child.pid !== undefined) {
				try {
					if (
						runtime.forwardSignal({
							pid: -child.pid,
							signal: selectedSignal,
						})
					) {
						return true;
					}
				} catch {
					// The direct-child fallback below remains available.
				}
			}
			try {
				return child.kill(selectedSignal);
			} catch {
				return false;
			}
		};
		const forceKill = (): void => {
			if (!deliver("SIGKILL")) {
				settle({
					error:
						interruption ??
						new ShopifyE2EInfrastructureError(
							"Playwright process could not be terminated",
						),
				});
				return;
			}
			killTimer = setTimeout(() => {
				settle({
					error:
						interruption ??
						new ShopifyE2EInfrastructureError(
							"Playwright process could not be terminated",
						),
				});
			}, terminationGraceMs);
			killTimer.unref();
		};
		function onAbort(): void {
			if (interruption || !signal) return;
			interruption = errorFromAbortSignal(signal);
			// Playwright 1.61 owns graceful runner and web-server teardown on
			// SIGINT, while the parent retains the developer's original exit code.
			if (!deliver(playwrightAbortSignal(signal))) {
				forceKill();
				return;
			}
			graceTimer = setTimeout(forceKill, terminationGraceMs);
			graceTimer.unref();
		}

		child.once("error", (cause) => {
			if (interruption) {
				deliver("SIGKILL");
				settle({ error: interruption });
				return;
			}
			const peerExecutable = invocation.args[0] ?? "the selected peer";
			settle({
				error: new ShopifyE2EInfrastructureError(
					`Could not start Playwright executable ${peerExecutable} with ${invocation.executable}`,
					{ cause },
				),
			});
		});

		child.once("exit", (code, exitSignal) => {
			if (interruption) {
				deliver("SIGKILL");
				settle({ error: interruption });
				return;
			}
			if (code !== null) {
				settle({ exitCode: code });
				return;
			}
			if (exitSignal !== null) {
				const exitCode = signalExitCode(exitSignal);
				if (exitCode !== undefined) {
					settle({ exitCode });
					return;
				}
			}
			settle({
				error: new ShopifyE2EInfrastructureError(
					"Playwright process ended without a usable exit outcome",
				),
			});
		});

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		}
	});
};
