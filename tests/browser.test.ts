import { describe, expect, it } from "vitest";

import {
	assertLoopbackCdpUrl,
	type FetchLike,
	isCdpReachable,
	isLoopbackCdpUrl,
} from "../src/browser.js";

describe("CDP endpoint safety", () => {
	it.each([
		"http://127.0.0.1:9222",
		"http://127.15.20.25:9222",
		"ws://localhost:9222/devtools/browser/id",
		"http://[::1]:9222",
	])("classifies %s as loopback", (cdpUrl) => {
		expect(isLoopbackCdpUrl(cdpUrl)).toBe(true);
		expect(() => assertLoopbackCdpUrl(cdpUrl)).not.toThrow();
	});

	it.each([
		"https://cdp.example.com",
		"http://0.0.0.0:9222",
		"http://127.example.com:9222",
		"http://127.0.0.999:9222",
		"http://localhost.example.com:9222",
		"not-a-url",
	])("classifies %s as non-loopback without throwing", (cdpUrl) => {
		expect(() => isLoopbackCdpUrl(cdpUrl)).not.toThrow();
		expect(isLoopbackCdpUrl(cdpUrl)).toBe(false);
		expect(() => assertLoopbackCdpUrl(cdpUrl)).toThrow(
			`Shopify auth profiles require a loopback CDP URL; received ${cdpUrl}.`,
		);
	});
});

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
