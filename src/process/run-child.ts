import { spawn } from "node:child_process";
import { constants } from "node:os";

import { ShopifyE2EInfrastructureError } from "../errors.js";
import type { PlaywrightInvocation } from "../playwright/invocation.js";

const forwardedSignals = ["SIGINT", "SIGTERM"] as const;
type ForwardedSignal = (typeof forwardedSignals)[number];
type SignalListener = () => void;

export interface ChildProcessRuntime {
	readonly addSignalListener: (
		signal: ForwardedSignal,
		listener: SignalListener,
	) => void;
	readonly forwardSignal: (pid: number, signal: ForwardedSignal) => boolean;
	readonly platform: NodeJS.Platform;
	readonly removeSignalListener: (
		signal: ForwardedSignal,
		listener: SignalListener,
	) => void;
	readonly spawn: typeof spawn;
}

const defaultRuntime: ChildProcessRuntime = {
	addSignalListener(signal, listener) {
		process.on(signal, listener);
	},
	forwardSignal(pid, signal) {
		return process.kill(pid, signal);
	},
	platform: process.platform,
	removeSignalListener(signal, listener) {
		process.off(signal, listener);
	},
	spawn,
};

function isPosix(platform: NodeJS.Platform): boolean {
	return platform !== "win32";
}

function signalExitCode(signal: NodeJS.Signals): number | undefined {
	const signalNumber = constants.signals[signal];
	return typeof signalNumber === "number" ? 128 + signalNumber : undefined;
}

export async function runChild(
	invocation: PlaywrightInvocation,
	runtime: ChildProcessRuntime = defaultRuntime,
): Promise<number> {
	const posix = isPosix(runtime.platform);
	const child = runtime.spawn(invocation.executable, invocation.args, {
		detached: posix,
		shell: false,
		stdio: "inherit",
	});

	return new Promise<number>((resolve, reject) => {
		let settled = false;
		const deliveredSignals = new Set<ForwardedSignal>();
		const signalListeners = new Map<ForwardedSignal, SignalListener>();

		const removeSignalListeners = (): void => {
			for (const [signal, listener] of signalListeners) {
				runtime.removeSignalListener(signal, listener);
			}
			signalListeners.clear();
		};

		const settle = (outcome: { error: Error } | { exitCode: number }): void => {
			if (settled) return;
			settled = true;
			removeSignalListeners();
			if ("error" in outcome) reject(outcome.error);
			else resolve(outcome.exitCode);
		};

		for (const signal of forwardedSignals) {
			const listener = (): void => {
				if (deliveredSignals.has(signal)) return;
				deliveredSignals.add(signal);
				try {
					if (posix && child.pid !== undefined) {
						runtime.forwardSignal(-child.pid, signal);
					} else {
						child.kill(signal);
					}
				} catch (cause) {
					settle({
						error: new ShopifyE2EInfrastructureError(
							`Could not forward ${signal} to the Playwright process`,
							{ cause },
						),
					});
				}
			};
			signalListeners.set(signal, listener);
			runtime.addSignalListener(signal, listener);
		}

		child.once("error", (cause) => {
			const peerExecutable = invocation.args[0] ?? "the selected peer";
			settle({
				error: new ShopifyE2EInfrastructureError(
					`Could not start Playwright executable ${peerExecutable} with ${invocation.executable}`,
					{ cause },
				),
			});
		});

		child.once("exit", (code, signal) => {
			if (code !== null) {
				settle({ exitCode: code });
				return;
			}
			if (signal !== null) {
				const exitCode = signalExitCode(signal);
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
	});
}
