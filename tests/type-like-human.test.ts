import type { Locator } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";

import { typeLikeHuman } from "../src/playwright/type-like-human.js";

const makeLocator = () => {
	const pressSequentially = vi.fn(async () => undefined);
	return {
		locator: { pressSequentially } as unknown as Locator,
		pressSequentially,
	};
};

describe("human-style typing", () => {
	it("types the exact text once with the default delay", async () => {
		const { locator, pressSequentially } = makeLocator();

		await typeLikeHuman(locator, "levelogy development");

		expect(pressSequentially).toHaveBeenCalledOnce();
		expect(pressSequentially).toHaveBeenCalledWith("levelogy development", {
			delay: 50,
		});
	});

	it.each([0, 1, 125])("honors the %d ms delay override", async (delay) => {
		const { locator, pressSequentially } = makeLocator();

		await typeLikeHuman(locator, "text", { delay });

		expect(pressSequentially).toHaveBeenCalledOnce();
		expect(pressSequentially).toHaveBeenCalledWith("text", { delay });
	});

	it.each([
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	])("rejects invalid delay %s before using the locator", async (delay) => {
		const { locator, pressSequentially } = makeLocator();

		await expect(typeLikeHuman(locator, "text", { delay })).rejects.toThrow(
			/delay.*finite non-negative number/i,
		);
		expect(pressSequentially).not.toHaveBeenCalled();
	});

	it("delegates empty text normally", async () => {
		const { locator, pressSequentially } = makeLocator();

		await typeLikeHuman(locator, "");

		expect(pressSequentially).toHaveBeenCalledOnce();
		expect(pressSequentially).toHaveBeenCalledWith("", { delay: 50 });
	});
});
