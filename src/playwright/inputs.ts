import type { Frame, Locator, Page } from "playwright-core";

import { delay } from "../browser.js";

export interface SlowInputOptions {
	actionDelayMs?: number;
	inputDelayMs?: number;
}

export interface FirstVisibleOptions extends SlowInputOptions {
	includeFrames?: boolean;
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

export async function fillFirstVisible(
	page: Page,
	selectors: string[],
	value: string,
	options: FirstVisibleOptions = {},
): Promise<boolean> {
	const locator = await firstUsableLocator(page, selectors);

	if (locator) {
		await slowFill(locator, value, options);

		return true;
	}

	if (!options.includeFrames) {
		return false;
	}

	for (const frame of page.frames()) {
		const frameLocator = await firstUsableLocator(frame, selectors);

		if (frameLocator) {
			await slowFill(frameLocator, value, options);

			return true;
		}
	}

	return false;
}

export async function selectFirstVisible(
	page: Page,
	selectors: string[],
	value: string,
	options: SlowInputOptions = {},
): Promise<boolean> {
	const locator = await firstUsableLocator(page, selectors);

	if (!locator) {
		return false;
	}

	await slowSelect(locator, value, options);

	return true;
}

export async function clickFirstVisibleButton(
	page: Page,
	names: RegExp[],
	options: SlowInputOptions = {},
): Promise<boolean> {
	for (const name of names) {
		const button = page.getByRole("button", { name }).first();

		if (await isUsable(button)) {
			await slowClick(button, options);

			return true;
		}
	}

	return false;
}

export async function firstUsableLocator(
	root: Page | Frame,
	selectors: string[],
): Promise<Locator | null> {
	for (const selector of selectors) {
		const locator = root.locator(selector).first();

		if (await isUsable(locator)) {
			return locator;
		}
	}

	return null;
}

export async function isUsable(locator: Locator): Promise<boolean> {
	return (
		(await locator.count()) > 0 &&
		(await locator.isVisible().catch(() => false)) &&
		(await locator.isEnabled().catch(() => true))
	);
}
