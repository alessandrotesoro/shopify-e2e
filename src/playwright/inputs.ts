import type { Locator } from "playwright-core";

import { delay } from "../browser.js";

export interface SlowInputOptions {
	actionDelayMs?: number;
	inputDelayMs?: number;
}

const defaultActionDelayMs = 500;
const defaultInputDelayMs = 65;

export async function slowFill(
	locator: Locator,
	value: string,
	options: SlowInputOptions = {},
): Promise<void> {
	const actionDelayMs = options.actionDelayMs ?? defaultActionDelayMs;
	const inputDelayMs = options.inputDelayMs ?? defaultInputDelayMs;

	await locator.scrollIntoViewIfNeeded().catch(() => undefined);
	await delay(actionDelayMs);

	const currentValue = await locator.inputValue().catch(() => null);

	if (currentValue === value) {
		return;
	}

	await locator.focus();
	await locator.fill("").catch(() => undefined);
	await locator
		.pressSequentially(value, { delay: inputDelayMs })
		.catch(async () => locator.fill(value));
	await delay(actionDelayMs);
}

export async function slowClick(
	locator: Locator,
	options: SlowInputOptions = {},
): Promise<void> {
	const actionDelayMs = options.actionDelayMs ?? defaultActionDelayMs;
	const inputDelayMs = options.inputDelayMs ?? defaultInputDelayMs;

	await delay(actionDelayMs);
	await locator.click({ delay: inputDelayMs });
	await delay(actionDelayMs);
}

export async function slowSelect(
	locator: Locator,
	value: string,
	options: SlowInputOptions = {},
): Promise<void> {
	await locator
		.selectOption(value)
		.catch(async () => locator.selectOption({ label: value }));
	await delay(options.actionDelayMs ?? defaultActionDelayMs);
}
