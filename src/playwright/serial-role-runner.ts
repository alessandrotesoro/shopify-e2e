import type { ShopifyE2EInfrastructureError } from "../errors.js";
import {
	CommandSignalError,
	commandSignalFromReason,
} from "../process/command-signals.js";

export type RoleRunStatus = "failed" | "interrupted" | "not-run" | "passed";

export interface RoleRunOutcome {
	readonly exitCode?: number;
	readonly role: string;
	readonly status: RoleRunStatus;
}

interface RoleSelection {
	readonly role: string;
}

export interface RunRolesSeriallyArgs<Selection extends RoleSelection> {
	readonly browserUnexpectedClose: Promise<ShopifyE2EInfrastructureError>;
	readonly reportActiveRole: (role: string) => void;
	readonly reportSummary: (outcomes: readonly RoleRunOutcome[]) => void;
	readonly runRole: (
		selection: Selection,
		signal: AbortSignal,
	) => Promise<number>;
	readonly selections: readonly Selection[];
	readonly signal: AbortSignal;
}

const interruptionFor = (signal: AbortSignal): CommandSignalError =>
	new CommandSignalError(commandSignalFromReason(signal.reason));

export const runRolesSerially = async <Selection extends RoleSelection>({
	browserUnexpectedClose,
	reportActiveRole,
	reportSummary,
	runRole,
	selections,
	signal,
}: RunRolesSeriallyArgs<Selection>): Promise<number> => {
	const browserController = new AbortController();
	void browserUnexpectedClose.then((error) => browserController.abort(error));
	const roleSignal = AbortSignal.any([signal, browserController.signal]);
	const outcomes: RoleRunOutcome[] = selections.map(({ role }) => ({
		role,
		status: "not-run",
	}));
	let exitCode = 0;
	let failure: unknown;

	for (const [index, selection] of selections.entries()) {
		const { role } = selection;
		if (signal.aborted) {
			failure = interruptionFor(signal);
			break;
		}
		if (browserController.signal.aborted) {
			failure = browserController.signal.reason;
			break;
		}
		reportActiveRole(role);
		try {
			const roleExitCode = await runRole(selection, roleSignal);
			if (signal.aborted) {
				outcomes[index] = { role, status: "interrupted" };
				failure = interruptionFor(signal);
				break;
			}
			if (browserController.signal.aborted) {
				outcomes[index] = { role, status: "failed" };
				failure = browserController.signal.reason;
				break;
			}
			if (roleExitCode !== 0) {
				outcomes[index] = {
					exitCode: roleExitCode,
					role,
					status: "failed",
				};
				exitCode = roleExitCode;
				break;
			}
			outcomes[index] = { role, status: "passed" };
		} catch (error) {
			if (signal.aborted) {
				outcomes[index] = { role, status: "interrupted" };
				failure =
					error instanceof CommandSignalError ? error : interruptionFor(signal);
			} else {
				outcomes[index] = { role, status: "failed" };
				failure = browserController.signal.aborted
					? browserController.signal.reason
					: error;
			}
			break;
		}
	}

	reportSummary(Object.freeze(outcomes));
	if (failure !== undefined) throw failure;
	return exitCode;
};
