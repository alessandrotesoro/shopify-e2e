import { describe, expect, it, vi } from "vitest";

const { openStorefront, unlockStorefront } = vi.hoisted(() => ({
	openStorefront: vi.fn(async () => undefined),
	unlockStorefront: vi.fn(async () => undefined),
}));

vi.mock("../src/playwright/storefront.cjs", () => ({
	openStorefront,
	unlockStorefront,
}));

import { shopifyFixtures } from "../src/playwright/fixtures.cjs";
import * as publicApi from "../src/playwright/public.cjs";

const storefrontFixture = () => {
	const fixture = shopifyFixtures.storefront;
	if (typeof fixture !== "function") {
		throw new TypeError(
			"Expected storefront to be a test-scoped fixture function",
		);
	}
	return fixture;
};

describe("Shopify Playwright fixtures", () => {
	it("publishes only the approved runtime surface", () => {
		expect(Object.keys(publicApi).sort()).toEqual([
			"shopifyFixtures",
			"typeLikeHuman",
			"unlockStorefront",
		]);
		expect(publicApi.shopifyFixtures).toBe(shopifyFixtures);
	});

	it("is one lazy test-scoped fixture definition with no eager behavior", () => {
		expect(Object.keys(shopifyFixtures)).toEqual(["storefront"]);
		expect(shopifyFixtures.storefront).toBeTypeOf("function");
		expect(openStorefront).not.toHaveBeenCalled();
		expect(unlockStorefront).not.toHaveBeenCalled();
	});

	it("yields once and binds both actions to the consumer page", async () => {
		const page = { consumerPage: true };
		const use = vi.fn(async (storefront: unknown) => {
			expect(storefront).toMatchObject({
				open: expect.any(Function),
				unlock: expect.any(Function),
			});
			const actions = storefront as {
				open(): Promise<void>;
				unlock(): Promise<void>;
			};
			await actions.open();
			await actions.unlock();
		});

		await Reflect.apply(storefrontFixture(), undefined, [{ page }, use, {}]);

		expect(use).toHaveBeenCalledOnce();
		expect(openStorefront).toHaveBeenCalledOnce();
		expect(openStorefront).toHaveBeenCalledWith(page);
		expect(unlockStorefront).toHaveBeenCalledOnce();
		expect(unlockStorefront).toHaveBeenCalledWith(page);
	});

	it("keeps the fixture alive until the consumer finishes using it", async () => {
		let release: (() => void) | undefined;
		const consumerFinished = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fixtureRun = Reflect.apply(storefrontFixture(), undefined, [
			{ page: {} },
			async () => consumerFinished,
			{},
		]);
		let settled = false;
		void Promise.resolve(fixtureRun).then(() => {
			settled = true;
		});

		await Promise.resolve();
		expect(settled).toBe(false);
		release?.();
		await fixtureRun;
		expect(settled).toBe(true);
	});
});
