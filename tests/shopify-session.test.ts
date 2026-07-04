import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/browser.js";
import type { ResolvedShopifyE2EConfig } from "../src/shopify-e2e-config.js";
import { inspectShopifySession } from "../src/shopify-session.js";

const config: ResolvedShopifyE2EConfig = {
	authStatePath: "/tmp/auth.json",
	cdpPort: "9222",
	cdpUrl: "http://127.0.0.1:9222",
	chromeProfilePath: "/tmp/profile",
	cwd: "/tmp",
	live: true,
	shopDomain: "example.myshopify.com",
	testCommand: {
		args: ["playwright", "test"],
		command: "npx",
		mode: "playwright",
		shell: false,
	},
	testFiles: [],
};

describe("inspectShopifySession", () => {
	it("reports ready when an admin tab for the shop exists", async () => {
		const fetchImpl: FetchLike = async () => ({
			json: async () => [
				{
					type: "page",
					url: "https://admin.shopify.com/store/example/apps/app",
				},
			],
			ok: true,
			status: 200,
		});

		await expect(
			inspectShopifySession(config, { fetch: fetchImpl }),
		).resolves.toMatchObject({
			state: "ready",
		});
	});

	it("reports login-required when pages do not include the configured admin", async () => {
		const fetchImpl: FetchLike = async () => ({
			json: async () => [
				{
					type: "page",
					url: "https://accounts.shopify.com/login",
				},
			],
			ok: true,
			status: 200,
		});

		await expect(
			inspectShopifySession(config, { fetch: fetchImpl }),
		).resolves.toMatchObject({
			state: "login-required",
		});
	});
});
