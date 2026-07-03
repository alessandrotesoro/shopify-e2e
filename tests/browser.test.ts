import { describe, expect, it } from "vitest";

import { isCdpReachable, type FetchLike } from "../src/browser.js";

describe("isCdpReachable", () => {
	it("returns true when devtools version responds ok", async () => {
		const fetchImpl: FetchLike = async () => ({
			json: async () => ({}),
			ok: true,
			status: 200,
		});

		await expect(
			isCdpReachable("http://127.0.0.1:9222", { fetch: fetchImpl }),
		).resolves.toBe(true);
	});

	it("returns false when devtools fetch fails", async () => {
		const fetchImpl: FetchLike = async () => {
			throw new Error("offline");
		};

		await expect(
			isCdpReachable("http://127.0.0.1:9222", { fetch: fetchImpl }),
		).resolves.toBe(false);
	});
});
