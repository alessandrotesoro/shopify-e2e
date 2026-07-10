import { createInterface } from "node:readline";

import type { Page } from "playwright-core";

export interface InteractiveInput extends NodeJS.ReadableStream {
	isTTY?: boolean;
}

export interface InteractiveSignals {
	off(event: "SIGINT", listener: () => void): unknown;
	once(event: "SIGINT", listener: () => void): unknown;
}

export type InteractiveConfirmation = "cancelled" | "confirmed";

export interface InteractiveConfirmationOptions {
	input?: InteractiveInput;
	page: Page;
	signals?: InteractiveSignals;
}

export function assertInteractiveInput(
	input: InteractiveInput = process.stdin,
): void {
	if (!input.isTTY) {
		throw new Error(
			"Guided Shopify auth profile capture requires an interactive TTY.",
		);
	}
}

export async function waitForInteractiveConfirmation({
	input = process.stdin,
	page,
	signals = process,
}: InteractiveConfirmationOptions): Promise<InteractiveConfirmation> {
	assertInteractiveInput(input);

	if (page.isClosed()) {
		return "cancelled";
	}

	const lines = createInterface({ input, terminal: Boolean(input.isTTY) });

	return new Promise((resolve) => {
		let settled = false;

		const settle = (result: InteractiveConfirmation): void => {
			if (settled) {
				return;
			}

			settled = true;
			lines.off("line", onLine);
			lines.off("close", onInputClose);
			page.off("close", onPageClose);
			signals.off("SIGINT", onSigint);
			lines.close();
			resolve(result);
		};
		const onLine = (line: string): void => {
			if (line.length === 0) {
				settle("confirmed");
			}
		};
		const onInputClose = (): void => settle("cancelled");
		const onPageClose = (): void => settle("cancelled");
		const onSigint = (): void => settle("cancelled");

		lines.on("line", onLine);
		lines.once("close", onInputClose);
		page.once("close", onPageClose);
		signals.once("SIGINT", onSigint);
	});
}
