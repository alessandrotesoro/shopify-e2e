import { describe, expect, it, vi } from "vitest";

import { slowClick, slowFill } from "../src/playwright/inputs.js";

describe("slow input helpers", () => {
	it("types sequentially after clearing current value", async () => {
		const calls: string[] = [];
		const locator = {
			fill: vi.fn(async (value: string) => {
				calls.push(`fill:${value}`);
			}),
			focus: vi.fn(async () => {
				calls.push("focus");
			}),
			inputValue: vi.fn(async () => "old"),
			pressSequentially: vi.fn(async (value: string) => {
				calls.push(`type:${value}`);
			}),
			scrollIntoViewIfNeeded: vi.fn(async () => undefined),
		};

		await slowFill(locator as never, "new", {
			actionDelayMs: 0,
			inputDelayMs: 0,
		});

		expect(calls).toEqual(["focus", "fill:", "type:new"]);
	});

	it("clicks with a human-paced delay option", async () => {
		const locator = {
			click: vi.fn(async () => undefined),
		};

		await slowClick(locator as never, {
			actionDelayMs: 0,
			inputDelayMs: 0,
		});

		expect(locator.click).toHaveBeenCalledWith({ delay: 0 });
	});
});
