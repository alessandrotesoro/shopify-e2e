import { spawn } from "node:child_process";
import { constants } from "node:os";

import { ShopifyE2EInfrastructureError } from "../errors.js";
import type { PlaywrightInvocation } from "../playwright/invocation.js";
import {
	CommandSignalError,
	commandSignalFromReason,
} from "./command-signals.js";

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
}

const defaultRuntime: ChildProcessRuntime = {
	forwardSignal: ({ pid, signal }) => process.kill(pid, signal),
	platform: process.platform,
	spawn,
};

const isPosix = (platform: NodeJS.Platform): boolean => platform !== "win32";

const signalExitCode = (signal: NodeJS.Signals): number | undefined => {
	const signalNumber = constants.signals[signal];
	return typeof signalNumber === "number" ? 128 + signalNumber : undefined;
};

const abortError = (signal: AbortSignal): Error => {
	if (signal.reason instanceof Error) return signal.reason;
	return new CommandSignalError(commandSignalFromReason(signal.reason));
};

const abortSignal = (signal: AbortSignal): "SIGINT" | "SIGTERM" =>
	signal.reason === "SIGINT" ? "SIGINT" : "SIGTERM";

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
	const child = runtime.spawn(invocation.executable, invocation.args, {
		detached: isPosixPlatform,
		...(invocation.environment === undefined
			? {}
			: { env: invocation.environment }),
		shell: false,
		stdio: "inherit",
	});

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
			deliver("SIGKILL");
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
			interruption = abortError(signal);
			deliver(abortSignal(signal));
			graceTimer = setTimeout(forceKill, terminationGraceMs);
			graceTimer.unref();
		}

		child.once("error", (cause) => {
			if (interruption) {
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
