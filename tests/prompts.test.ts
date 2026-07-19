import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const promptMocks = vi.hoisted(() => ({
	checkbox: vi.fn(async () => ["selected"]),
	confirm: vi.fn(async () => true),
	select: vi.fn(async () => "selected"),
}));

vi.mock("@inquirer/prompts", () => promptMocks);

import { inquirerPrompts } from "../src/prompts/inquirer.js";

beforeEach(() => vi.clearAllMocks());

describe("Inquirer prompt boundary", () => {
	it("passes injected streams, AbortSignal, and a required choice to checkbox", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const signal = new AbortController().signal;

		await inquirerPrompts.checkbox({
			choices: [{ name: "Selected", value: "selected" }],
			input,
			message: "Choose",
			output,
			required: true,
			signal,
		});

		expect(promptMocks.checkbox).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Choose", required: true }),
			{ input, output, signal },
		);
	});

	it("passes injected streams and AbortSignal to select", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const signal = new AbortController().signal;

		await inquirerPrompts.select({
			choices: [{ name: "Selected", value: "selected" }],
			input,
			message: "Choose",
			output,
			signal,
		});

		expect(promptMocks.select).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Choose" }),
			{ input, output, signal },
		);
	});

	it("forwards cancellation context and the default to confirm", async () => {
		const signal = new AbortController().signal;

		await inquirerPrompts.confirm({
			default: false,
			message: "Save?",
			signal,
		});

		expect(promptMocks.confirm).toHaveBeenCalledWith(
			{ default: false, message: "Save?" },
			expect.objectContaining({ signal }),
		);
	});
});
