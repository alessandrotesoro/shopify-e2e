import type { Locator, Page } from "playwright-core";
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
		const locator = locatorDouble({ calls, value: "old" });

		await slowFill(locator, "new", {
			actionDelayMs: 0,
			inputDelayMs: 0,
		});

		expect(calls).toEqual(["focus", "fill:", "type:new"]);
	});

	it("clicks with a human-paced delay option", async () => {
		const locator = locatorDouble();

		await slowClick(locator, {
			actionDelayMs: 0,
			inputDelayMs: 0,
		});

		expect(locator.click).toHaveBeenCalledWith({ delay: 0 });
	});

	it("fills the first usable selector", async () => {
		const hidden = locatorDouble({ visible: false });
		const visible = locatorDouble({ value: "old" });
		const page = selectorPageDouble((selector) =>
			selector === "#first" ? hidden : visible,
		);

		await expect(
			fillFirstVisible(page, ["#first", "#second"], "new", {
				actionDelayMs: 0,
				inputDelayMs: 0,
			}),
		).resolves.toBe(true);
		expect(visible.pressSequentially).toHaveBeenCalledWith("new", {
			delay: 0,
		});
	});

	it("clicks the first usable named button", async () => {
		const missing = locatorDouble({ visible: false });
		const visible = locatorDouble();
		const page = buttonPageDouble((name) =>
			name.test("Submit") ? visible : missing,
		);

		await expect(
			clickFirstVisibleButton(page, [/enter/i, /submit/i], {
				actionDelayMs: 0,
				inputDelayMs: 0,
			}),
		).resolves.toBe(true);
		expect(visible.click).toHaveBeenCalledWith({ delay: 0 });
	});
});

type LocatorDouble = Locator & ReturnType<typeof locatorShape>;

function locatorDouble(
	options: { calls?: string[]; value?: string; visible?: boolean } = {},
): LocatorDouble {
	return locatorShape(options) as unknown as LocatorDouble;
}

function locatorShape(
	options: { calls?: string[]; value?: string; visible?: boolean } = {},
) {
	const calls = options.calls;

	return {
		click: vi.fn(async () => undefined),
		fill: vi.fn(async (value: string) => {
			calls?.push(`fill:${value}`);
		}),
		focus: vi.fn(async () => {
			calls?.push("focus");
		}),
		inputValue: vi.fn(async () => options.value ?? ""),
		isEnabled: vi.fn(async () => true),
		isVisible: vi.fn(async () => options.visible ?? true),
		pressSequentially: vi.fn(async (value: string) => {
			calls?.push(`type:${value}`);
		}),
		scrollIntoViewIfNeeded: vi.fn(async () => undefined),
	};
}

function selectorPageDouble(
	locatorForSelector: (selector: string) => LocatorDouble,
): Page {
	return {
		frames: vi.fn(() => []),
		locator: vi.fn((selector: string) => ({
			first: () => locatorForSelector(selector),
		})),
	} as unknown as Page;
}

function buttonPageDouble(
	locatorForName: (name: RegExp) => LocatorDouble,
): Page {
	return {
		getByRole: vi.fn((_role: string, options: { name: RegExp }) => ({
			first: () => locatorForName(options.name),
		})),
	} as unknown as Page;
}
