import { describe, expect, it, vi } from "vitest";

import { ShopifyE2EInfrastructureError } from "../src/errors.js";
import { runRolesSerially } from "../src/playwright/serial-role-runner.js";
import { CommandSignalError } from "../src/process/command-signals.js";

describe("serial role runner", () => {
	it("runs roles one at a time in order and reports passed outcomes", async () => {
		const events: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const runRole = vi.fn(async ({ role }: { readonly role: string }) => {
			events.push(`start:${role}`);
			if (role === "admin") await first;
			events.push(`end:${role}`);
			return 0;
		});
		const reportSummary = vi.fn();
		const outcome = runRolesSerially({
			browserUnexpectedClose: new Promise(() => undefined),
			reportActiveRole: (role) => events.push(`report:${role}`),
			reportSummary,
			runRole,
			selections: [{ role: "admin" }, { role: "customer" }],
			signal: new AbortController().signal,
		});

		await vi.waitFor(() => expect(runRole).toHaveBeenCalledTimes(1));
		expect(events).toEqual(["report:admin", "start:admin"]);
		releaseFirst?.();

		await expect(outcome).resolves.toBe(0);
		expect(events).toEqual([
			"report:admin",
			"start:admin",
			"end:admin",
			"report:customer",
			"start:customer",
			"end:customer",
		]);
		expect(reportSummary).toHaveBeenCalledWith([
			{ role: "admin", status: "passed" },
			{ role: "customer", status: "passed" },
		]);
	});

	it("fails fast and leaves later roles not run", async () => {
		const reportSummary = vi.fn();
		await expect(
			runRolesSerially({
				browserUnexpectedClose: new Promise(() => undefined),
				reportActiveRole: vi.fn(),
				reportSummary,
				runRole: vi.fn(async ({ role }) => (role === "customer" ? 17 : 0)),
				selections: [
					{ role: "admin" },
					{ role: "customer" },
					{ role: "guest" },
				],
				signal: new AbortController().signal,
			}),
		).resolves.toBe(17);
		expect(reportSummary).toHaveBeenCalledWith([
			{ role: "admin", status: "passed" },
			{ exitCode: 17, role: "customer", status: "failed" },
			{ role: "guest", status: "not-run" },
		]);
	});

	it("marks the active role interrupted and preserves the command signal", async () => {
		const controller = new AbortController();
		const reportSummary = vi.fn();
		const outcome = runRolesSerially({
			browserUnexpectedClose: new Promise(() => undefined),
			reportActiveRole: vi.fn(),
			reportSummary,
			runRole: vi.fn(async (_selection, signal) => {
				controller.abort("SIGTERM");
				if (signal.aborted) throw new CommandSignalError("SIGTERM");
				return 0;
			}),
			selections: [{ role: "admin" }, { role: "customer" }],
			signal: controller.signal,
		}).catch((error: unknown) => error);

		await expect(outcome).resolves.toMatchObject({ exitCode: 143 });
		expect(reportSummary).toHaveBeenCalledWith([
			{ role: "admin", status: "interrupted" },
			{ role: "customer", status: "not-run" },
		]);
	});

	it("aborts the active role when Chromium closes unexpectedly", async () => {
		let closeBrowser:
			| ((error: ShopifyE2EInfrastructureError) => void)
			| undefined;
		const browserUnexpectedClose = new Promise<ShopifyE2EInfrastructureError>(
			(resolve) => {
				closeBrowser = resolve;
			},
		);
		const reportSummary = vi.fn();
		const outcome = runRolesSerially({
			browserUnexpectedClose,
			reportActiveRole: vi.fn(),
			reportSummary,
			runRole: vi.fn(
				(_selection, signal) =>
					new Promise<number>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), {
							once: true,
						});
					}),
			),
			selections: [{ role: "admin" }, { role: "customer" }],
			signal: new AbortController().signal,
		}).catch((error: unknown) => error);
		closeBrowser?.(
			new ShopifyE2EInfrastructureError(
				"Consumer Chromium server closed unexpectedly",
			),
		);

		await expect(outcome).resolves.toBeInstanceOf(
			ShopifyE2EInfrastructureError,
		);
		expect(reportSummary).toHaveBeenCalledWith([
			{ role: "admin", status: "failed" },
			{ role: "customer", status: "not-run" },
		]);
	});
});
