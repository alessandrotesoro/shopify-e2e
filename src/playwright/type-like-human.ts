import type { Locator } from "@playwright/test";

const DEFAULT_DELAY_MS = 50;

export interface TypeLikeHumanOptions {
	readonly delay?: number;
}

export const typeLikeHuman = async (
	locator: Locator,
	text: string,
	options: TypeLikeHumanOptions = {},
): Promise<void> => {
	const delay = options.delay ?? DEFAULT_DELAY_MS;
	if (!Number.isFinite(delay) || delay < 0) {
		throw new TypeError(
			"Human typing delay must be a finite non-negative number",
		);
	}

	await locator.pressSequentially(text, { delay });
};
