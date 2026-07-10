import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { Page } from "playwright-core";
import { describe, expect, it } from "vitest";

import {
	assertInteractiveInput,
	waitForInteractiveConfirmation,
} from "../src/interactive-session.js";

function terminalInput(): PassThrough & { isTTY: boolean } {
	const input = new PassThrough() as PassThrough & { isTTY: boolean };
	input.isTTY = true;

	return input;
}

function page(): Page & EventEmitter {
	const target = new EventEmitter() as Page & EventEmitter;
	Object.assign(target, { isClosed: () => false });

	return target;
}

describe("interactive sessions", () => {
	it("rejects non-TTY input clearly", () => {
		const input = new PassThrough() as PassThrough & { isTTY?: boolean };

		expect(() => assertInteractiveInput(input)).toThrow(
			"Guided Shopify auth profile capture requires an interactive TTY.",
		);
	});

	it("confirms only after an empty Enter line", async () => {
		const input = terminalInput();
		const targetPage = page();
		const signals = new EventEmitter();
		const result = waitForInteractiveConfirmation({
			input,
			page: targetPage,
			signals,
		});

		input.write("not-enter\n");
		input.write("\n");

		await expect(result).resolves.toBe("confirmed");
		expect(signals.listenerCount("SIGINT")).toBe(0);
		expect(targetPage.listenerCount("close")).toBe(0);
	});

	it("cancels when the page closes", async () => {
		const input = terminalInput();
		const targetPage = page();
		const signals = new EventEmitter();
		const result = waitForInteractiveConfirmation({
			input,
			page: targetPage,
			signals,
		});

		targetPage.emit("close");

		await expect(result).resolves.toBe("cancelled");
	});

	it("cancels on SIGINT without saving", async () => {
		const input = terminalInput();
		const targetPage = page();
		const signals = new EventEmitter();
		const result = waitForInteractiveConfirmation({
			input,
			page: targetPage,
			signals,
		});

		signals.emit("SIGINT");

		await expect(result).resolves.toBe("cancelled");
	});
});
