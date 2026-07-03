import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
	parseEnvFile,
	resolveShopifyE2EConfig,
} from "../src/config.js";

describe("resolveShopifyE2EConfig", () => {
	it("resolves flags over env over config over defaults", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "shopify-e2e-config-"));
		const configPath = join(cwd, "shopify-e2e.config.mjs");

		await writeFile(
			configPath,
			`export default {
				shopDomain: "config-shop.myshopify.com",
				appUrl: "https://config.example",
				cdpPort: 9333,
				testFiles: ["config-tests"]
			};`,
		);

		const config = await resolveShopifyE2EConfig(
			{
				configPath,
				cwd,
				shopDomain: "flag-shop.myshopify.com",
			},
			{
				SHOPIFY_E2E_APP_URL: "https://env.example",
			},
		);

		expect(config.shopDomain).toBe("flag-shop.myshopify.com");
		expect(config.appUrl).toBe("https://env.example");
		expect(config.cdpUrl).toBe("http://127.0.0.1:9333");
		expect(config.testFiles).toEqual(["config-tests"]);
	});

	it("auto-discovers default config files under cwd", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "shopify-e2e-config-discovery-"));
		const configPath = join(cwd, "shopify-e2e.config.json");

		await writeFile(
			configPath,
			JSON.stringify({
				appUrl: "https://discovered.example",
				cdpPort: 9336,
				shopDomain: "discovered.myshopify.com",
				testFiles: ["discovered-tests"],
			}),
		);

		const config = await resolveShopifyE2EConfig({ cwd }, {});

		expect(config.configPath).toBe(configPath);
		expect(config.shopDomain).toBe("discovered.myshopify.com");
		expect(config.appUrl).toBe("https://discovered.example");
		expect(config.cdpUrl).toBe("http://127.0.0.1:9336");
		expect(config.testFiles).toEqual(["discovered-tests"]);
	});

	it("loads env files without overriding shell env", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "shopify-e2e-env-"));
		const envFile = join(cwd, ".env");

		await writeFile(
			envFile,
			[
				"SHOPIFY_E2E_SHOP_DOMAIN=file-shop.myshopify.com",
				"SHOPIFY_E2E_APP_URL=https://file.example",
				"SHOPIFY_E2E_CDP_PORT=9334",
			].join("\n"),
		);

		const config = await resolveShopifyE2EConfig(
			{ cwd, envFile },
			{
				SHOPIFY_E2E_APP_URL: "https://shell.example",
			},
		);

		expect(config.shopDomain).toBe("file-shop.myshopify.com");
		expect(config.appUrl).toBe("https://shell.example");
		expect(config.cdpUrl).toBe("http://127.0.0.1:9334");
	});

	it("derives the CDP port from a configured CDP URL when no port override is set", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "shopify-e2e-cdp-url-"));
		const config = await resolveShopifyE2EConfig(
			{ cwd },
			{
				SHOPIFY_E2E_CDP_URL: "http://127.0.0.1:9335",
			},
		);

		expect(config.cdpUrl).toBe("http://127.0.0.1:9335");
		expect(config.cdpPort).toBe("9335");
	});
});

describe("parseEnvFile", () => {
	it("parses quoted values and inline comments", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "shopify-e2e-env-parse-"));
		const envFile = join(cwd, ".env");

		await writeFile(
			envFile,
			[
				'SHOPIFY_E2E_SHOP_DOMAIN="quoted.myshopify.com"',
				"SHOPIFY_E2E_APP_URL=https://example.test # local app",
			].join("\n"),
		);

		expect(parseEnvFile(envFile)).toMatchObject({
			SHOPIFY_E2E_APP_URL: "https://example.test",
			SHOPIFY_E2E_SHOP_DOMAIN: "quoted.myshopify.com",
		});
	});
});
