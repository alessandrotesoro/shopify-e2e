import { describe, expect, it, vi } from "vitest";

import {
	clickFirstVisibleButton,
	fillFirstVisible,
	slowClick,
	slowFill,
} from "../src/playwright/inputs.js";

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

	it("fills the first usable selector", async () => {
		const hidden = locatorDouble({ count: 1, visible: false });
		const visible = locatorDouble({ value: "old" });
		const page = {
			frames: vi.fn(() => []),
			locator: vi.fn((selector: string) => ({
				first: () => (selector === "#first" ? hidden : visible),
			})),
		};

		await expect(
			fillFirstVisible(page as never, ["#first", "#second"], "new", {
				actionDelayMs: 0,
				inputDelayMs: 0,
			}),
		).resolves.toBe(true);
		expect(visible.pressSequentially).toHaveBeenCalledWith("new", { delay: 0 });
	});

	it("clicks the first usable named button", async () => {
		const missing = locatorDouble({ count: 0 });
		const visible = locatorDouble();
		const page = {
			getByRole: vi.fn((_role: string, options: { name: RegExp }) => ({
				first: () => (options.name.test("Submit") ? visible : missing),
			})),
		};

		await expect(
			clickFirstVisibleButton(page as never, [/enter/i, /submit/i], {
				actionDelayMs: 0,
				inputDelayMs: 0,
			}),
		).resolves.toBe(true);
		expect(visible.click).toHaveBeenCalledWith({ delay: 0 });
	});
});

function locatorDouble(
	options: { count?: number; value?: string; visible?: boolean } = {},
) {
	return {
		click: vi.fn(async () => undefined),
		count: vi.fn(async () => options.count ?? 1),
		fill: vi.fn(async () => undefined),
		focus: vi.fn(async () => undefined),
		inputValue: vi.fn(async () => options.value ?? ""),
		isEnabled: vi.fn(async () => true),
		isVisible: vi.fn(async () => options.visible ?? true),
		pressSequentially: vi.fn(async () => undefined),
		scrollIntoViewIfNeeded: vi.fn(async () => undefined),
	};
}
