export interface CommandSignalScope {
	readonly signal: AbortSignal;
	dispose(): void;
	exitCode(): 130 | 143 | undefined;
}

export type CommandSignal = "SIGINT" | "SIGTERM";

export const commandSignalFromReason = (reason: unknown): CommandSignal =>
	reason === "SIGTERM" ? "SIGTERM" : "SIGINT";

const commandSignalExitCode = (signal: CommandSignal): 130 | 143 =>
	signal === "SIGTERM" ? 143 : 130;

export class CommandSignalError extends Error {
	public readonly exitCode: 130 | 143;
	public readonly signal: CommandSignal;

	public constructor(
		signal: CommandSignal,
		message = `Command interrupted by ${signal}`,
	) {
		super(message);
		this.name = "CommandSignalError";
		this.exitCode = commandSignalExitCode(signal);
		this.signal = signal;
	}
}

export const throwIfCommandAborted = (signal: AbortSignal): void => {
	if (signal.aborted) {
		throw new CommandSignalError(commandSignalFromReason(signal.reason));
	}
};

const awaitWithCommandSignal = async <Value>(
	operation: Promise<Value>,
	signal: AbortSignal,
): Promise<Value> => {
	if (signal.aborted) {
		// The operation may have started just before the abort. Consume its eventual
		// rejection even though the signal outcome wins this call.
		void operation.catch(() => undefined);
		throw new CommandSignalError(commandSignalFromReason(signal.reason));
	}
	return new Promise<Value>((resolve, reject) => {
		const onAbort = (): void => {
			reject(new CommandSignalError(commandSignalFromReason(signal.reason)));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				try {
					throwIfCommandAborted(signal);
					resolve(value);
				} catch (error) {
					reject(error);
				}
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
};

export const runWithCommandSignal = <Value>(
	operation: () => Promise<Value>,
	signal: AbortSignal,
): Promise<Value> => {
	throwIfCommandAborted(signal);
	return awaitWithCommandSignal(operation(), signal);
};

export const createCommandSignalScope = (): CommandSignalScope => {
	const controller = new AbortController();
	const onSigint = () => controller.abort("SIGINT");
	const onSigterm = () => controller.abort("SIGTERM");
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);

	return {
		dispose: () => {
			process.off("SIGINT", onSigint);
			process.off("SIGTERM", onSigterm);
		},
		exitCode: () => {
			if (!controller.signal.aborted) return undefined;
			return commandSignalExitCode(
				commandSignalFromReason(controller.signal.reason),
			);
		},
		signal: controller.signal,
	};
};
