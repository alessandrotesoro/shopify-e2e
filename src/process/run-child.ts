import { spawn } from "node:child_process";
import { constants } from "node:os";

import { ShopifyE2EInfrastructureError } from "../errors.js";
import type { PlaywrightInvocation } from "../playwright/invocation.js";

const forwardedSignals = ["SIGINT", "SIGTERM"] as const;
type ForwardedSignal = (typeof forwardedSignals)[number];
type ChildSignal = ForwardedSignal | "SIGKILL";
type SignalListener = () => void;
type ChildOutcome = { error: Error } | { exitCode: number };

export interface AddSignalListenerArgs {
	readonly listener: SignalListener;
	readonly signal: ForwardedSignal;
}

export interface ForwardSignalArgs {
	readonly pid: number;
	readonly signal: ChildSignal;
}

export interface RemoveSignalListenerArgs {
	readonly listener: SignalListener;
	readonly signal: ForwardedSignal;
}

export interface ChildProcessRuntime {
	readonly addSignalListener: (args: AddSignalListenerArgs) => void;
	readonly forwardSignal: (args: ForwardSignalArgs) => boolean;
	readonly platform: NodeJS.Platform;
	readonly removeSignalListener: (args: RemoveSignalListenerArgs) => void;
	readonly spawn: typeof spawn;
}

const defaultRuntime: ChildProcessRuntime = {
	addSignalListener: ({ listener, signal }) => {
		process.on(signal, listener);
	},
	forwardSignal: ({ pid, signal }) => {
		return process.kill(pid, signal);
	},
	platform: process.platform,
	removeSignalListener: ({ listener, signal }) => {
		process.off(signal, listener);
	},
	spawn,
};

const isPosix = (platform: NodeJS.Platform): boolean => {
	return platform !== "win32";
};

const signalExitCode = (signal: NodeJS.Signals): number | undefined => {
	const signalNumber = constants.signals[signal];
	return typeof signalNumber === "number" ? 128 + signalNumber : undefined;
};

export interface RunChildArgs {
	readonly invocation: PlaywrightInvocation;
	readonly runtime?: ChildProcessRuntime;
}

export const runChild = async ({
	invocation,
	runtime = defaultRuntime,
}: RunChildArgs): Promise<number> => {
	const isPosixPlatform = isPosix(runtime.platform);
	const child = runtime.spawn(invocation.executable, invocation.args, {
		detached: isPosixPlatform,
		shell: false,
		stdio: "inherit",
	});

	return new Promise<number>((resolve, reject) => {
		let isSettled = false;
		let forwardingError: ShopifyE2EInfrastructureError | undefined;
		const deliveredSignals = new Set<ForwardedSignal>();
		const signalListeners = new Map<ForwardedSignal, SignalListener>();

		const removeSignalListeners = (): void => {
			for (const [signal, listener] of signalListeners) {
				runtime.removeSignalListener({ listener, signal });
			}
			signalListeners.clear();
		};

		const settle = (outcome: ChildOutcome): void => {
			if (isSettled) return;
			isSettled = true;
			removeSignalListeners();
			if ("error" in outcome) reject(outcome.error);
			else resolve(outcome.exitCode);
		};

		const recoverFromForwardingFailure = (
			error: ShopifyE2EInfrastructureError,
		): void => {
			forwardingError = error;
			removeSignalListeners();

			let isTerminationInitiated = false;
			if (isPosixPlatform && child.pid !== undefined) {
				try {
					isTerminationInitiated = runtime.forwardSignal({
						pid: -child.pid,
						signal: "SIGKILL",
					});
				} catch {
					// Preserve the original forwarding error; direct-child recovery follows.
				}
			}

			if (!isTerminationInitiated) {
				try {
					isTerminationInitiated = child.kill("SIGKILL");
				} catch {
					// Preserve the original forwarding error as the single CLI diagnostic.
				}
			}

			if (!isTerminationInitiated) settle({ error });
		};

		for (const signal of forwardedSignals) {
			const listener = (): void => {
				if (forwardingError || deliveredSignals.has(signal)) return;
				deliveredSignals.add(signal);
				try {
					let wasSignalDelivered: boolean;
					if (isPosixPlatform && child.pid !== undefined) {
						wasSignalDelivered = runtime.forwardSignal({
							pid: -child.pid,
							signal,
						});
					} else {
						wasSignalDelivered = child.kill(signal);
					}
					if (!wasSignalDelivered) {
						recoverFromForwardingFailure(
							new ShopifyE2EInfrastructureError(
								`Could not forward ${signal} to the Playwright process`,
							),
						);
					}
				} catch (cause) {
					recoverFromForwardingFailure(
						new ShopifyE2EInfrastructureError(
							`Could not forward ${signal} to the Playwright process`,
							{ cause },
						),
					);
				}
			};
			signalListeners.set(signal, listener);
			runtime.addSignalListener({ listener, signal });
		}

		child.once("error", (cause) => {
			if (forwardingError) {
				settle({ error: forwardingError });
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

		child.once("exit", (code, signal) => {
			if (forwardingError) {
				settle({ error: forwardingError });
				return;
			}
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
};
