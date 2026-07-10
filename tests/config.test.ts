import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	configFlags,
	configOverridesFromFlags,
} from "../src/cli-config-flags.js";
import { resolveConfigInput } from "../src/resolve-config.js";
import {
	parseEnvFile,
	type ResolveConfigOptions,
	resolveShopifyE2EConfig,
} from "../src/shopify-e2e-config.js";

describe("resolveShopifyE2EConfig", () => {
	it("resolves flags over env over config over defaults", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "shopify-e2e-config-"));
		const configPath = join(cwd, "shopify-e2e.config.mjs");

		await writeFile(
			configPath,
			`export default {
				authProfile: "config-customer",
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
				authProfile: "option-customer",
				shopDomain: "flag-shop.myshopify.com",
			},
			{
				SHOPIFY_E2E_APP_URL: "https://env.example",
				SHOPIFY_E2E_AUTH_PROFILE: "env-customer",
				SHOPIFY_E2E_STOREFRONT_DOMAIN: "store.example.com",
			},
		);

		expect(config.shopDomain).toBe("flag-shop.myshopify.com");
		expect(config.storefrontDomain).toBe("store.example.com");
		expect(config.appUrl).toBe("https://env.example");
		expect(config.authProfile).toEqual({
			name: "option-customer",
			storageStatePath: join(
				cwd,
				".shopify-e2e/auth/profiles/option-customer.json",
			),
		});
		expect(config.cdpUrl).toBe("http://127.0.0.1:9333");
		expect(config.testFiles).toEqual(["config-tests"]);

		const envConfig = await resolveShopifyE2EConfig(
			{ configPath, cwd },
			{ SHOPIFY_E2E_AUTH_PROFILE: "env-customer" },
		);
		expect(envConfig.authProfile.name).toBe("env-customer");

		const fileConfig = await resolveShopifyE2EConfig(
			{ configPath, cwd },
			{},
		);
		expect(fileConfig.authProfile.name).toBe("config-customer");
	});

	it("resolves the default profile under the fixed project-local root", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "shopify-e2e-default-profile-"),
		);
		const config = await resolveShopifyE2EConfig({ cwd }, {});

		expect(config.authProfile).toEqual({
			name: "default",
			storageStatePath: join(
				cwd,
				".shopify-e2e/auth/profiles/default.json",
			),
		});
	});

	it.each([
		"default",
		"customer-a",
		"customer-01",
		"0",
		"a".repeat(64),
	])("accepts the canonical profile name %s", async (authProfile) => {
		const cwd = await mkdtemp(join(tmpdir(), "shopify-e2e-valid-profile-"));
		const config = await resolveShopifyE2EConfig({ authProfile, cwd }, {});

		expect(config.authProfile).toEqual({
			name: authProfile,
			storageStatePath: join(
				cwd,
				`.shopify-e2e/auth/profiles/${authProfile}.json`,
			),
		});
	});

	it.each([
		["uppercase", "Customer-a"],
		["underscore separator", "customer_a"],
		["slash separator", "customer/a"],
		["dot separator", "customer.a"],
		["space separator", "customer a"],
		["empty", ""],
		["leading hyphen", "-customer"],
		["trailing hyphen", "customer-"],
		["consecutive hyphens", "customer--a"],
		["overlength", "a".repeat(65)],
	])("rejects an invalid %s profile name", async (_label, authProfile) => {
		const cwd = await mkdtemp(
			join(tmpdir(), "shopify-e2e-invalid-profile-"),
		);

		await expect(
			resolveShopifyE2EConfig({ authProfile, cwd }, {}),
		).rejects.toThrow(
			`Invalid Shopify auth profile name ${JSON.stringify(authProfile)}.`,
		);
	});

	it("rejects legacy authStatePath in config files with file context", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "shopify-e2e-legacy-config-"));
		const configPath = join(cwd, "shopify-e2e.config.json");

		await writeFile(
			configPath,
			JSON.stringify({ authStatePath: "/tmp/legacy-auth.json" }),
		);

		await expect(
			resolveShopifyE2EConfig({ configPath, cwd }, {}),
		).rejects.toThrow(
			`Invalid Shopify E2E config at ${configPath}: authStatePath is no longer supported; use authProfile.`,
		);
	});

	it("rejects the legacy auth-state environment variable", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "shopify-e2e-legacy-env-"));

		await expect(
			resolveShopifyE2EConfig(
				{ cwd },
				{ SHOPIFY_E2E_AUTH_STATE_PATH: "/tmp/legacy-auth.json" },
			),
		).rejects.toThrow(
			"SHOPIFY_E2E_AUTH_STATE_PATH is no longer supported; use SHOPIFY_E2E_AUTH_PROFILE.",
		);
	});

	it("rejects the legacy auth-state variable from an env file", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "shopify-e2e-legacy-env-file-"),
		);
		const envFile = join(cwd, ".env");

		await writeFile(
			envFile,
			"SHOPIFY_E2E_AUTH_STATE_PATH=/tmp/legacy-auth.json",
		);

		await expect(
			resolveShopifyE2EConfig({ cwd, envFile }, {}),
		).rejects.toThrow(
			"SHOPIFY_E2E_AUTH_STATE_PATH is no longer supported; use SHOPIFY_E2E_AUTH_PROFILE.",
		);
	});

	it("rejects legacy authStatePath in programmatic input", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "shopify-e2e-legacy-option-"));
		const options = {
			authStatePath: "/tmp/legacy-auth.json",
			cwd,
		} as ResolveConfigOptions;

		await expect(resolveShopifyE2EConfig(options, {})).rejects.toThrow(
			"authStatePath is no longer supported; use authProfile.",
		);
	});

	it("recognizes resolved configuration by its resolved profile shape", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "shopify-e2e-resolved-input-"),
		);
		const resolved = await resolveShopifyE2EConfig(
			{ authProfile: "customer-a", cwd },
			{},
		);

		await expect(resolveConfigInput(resolved)).resolves.toBe(resolved);
	});

	it("does not trust a forged path in resolved configuration input", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "shopify-e2e-forged-resolved-input-"),
		);
		const resolved = await resolveShopifyE2EConfig(
			{ authProfile: "customer-a", cwd },
			{},
		);
		const forged = {
			...resolved,
			authProfile: {
				...resolved.authProfile,
				storageStatePath: join(cwd, "outside-fixed-root.json"),
			},
		};

		await expect(resolveConfigInput(forged)).rejects.toThrow(
			"Invalid Shopify auth profile name",
		);
	});

	it("maps profile and Chrome profile flags without legacy aliases", () => {
		expect(configFlags).toHaveProperty("auth-profile");
		expect(configFlags).toHaveProperty("chrome-profile-path");
		expect(configFlags).not.toHaveProperty("auth-state");
		expect(configFlags).not.toHaveProperty("profile-path");
		expect(
			configOverridesFromFlags({
				"auth-profile": "customer-a",
				"chrome-profile-path": "/tmp/chrome-profile",
			}),
		).toMatchObject({
			authProfile: "customer-a",
			chromeProfilePath: "/tmp/chrome-profile",
		});
		expect(
			configOverridesFromFlags({ "auth-profile": "" }).authProfile,
		).toBe("");
	});

	it("auto-discovers default config files under cwd", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "shopify-e2e-config-discovery-"),
		);
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

	it("validates and coerces documented config file fields", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "shopify-e2e-config-shape-"));
		const configPath = join(cwd, "shopify-e2e.config.json");

		await writeFile(
			configPath,
			JSON.stringify({
				appSetupCommand: {
					args: ["artisan", "e2e:shopify:prepare"],
					command: "php",
					mode: "custom",
				},
				appUrl: "https://shape.example",
				live: "false",
				shopDomain: "shape.myshopify.com",
				testCommand: {
					args: ["playwright", "test"],
					mode: "custom",
				},
			}),
		);

		const config = await resolveShopifyE2EConfig({ cwd }, {});

		expect(config.live).toBe(false);
		expect(config.appSetupCommand).toMatchObject({
			args: ["artisan", "e2e:shopify:prepare"],
			command: "php",
			mode: "custom",
		});
		expect(config.testCommand).toMatchObject({
			args: ["playwright", "test"],
			mode: "custom",
		});
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

	it("resolves a non-loopback CDP URL for diagnostic reporting", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "shopify-e2e-remote-cdp-"));
		const config = await resolveShopifyE2EConfig(
			{ cdpUrl: "https://cdp.example.com", cwd },
			{},
		);

		expect(config.cdpUrl).toBe("https://cdp.example.com");
	});

	it("throws config file errors with file context", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "shopify-e2e-bad-config-"));
		const configPath = join(cwd, "shopify-e2e.config.json");

		await writeFile(configPath, "{");

		await expect(
			resolveShopifyE2EConfig({ configPath, cwd }, {}),
		).rejects.toThrow(
			`Could not parse Shopify E2E config from ${configPath}.`,
		);
	});

	it("throws app setup command shape errors with config file context", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "shopify-e2e-invalid-setup-config-"),
		);
		const configPath = join(cwd, "shopify-e2e.config.json");

		await writeFile(
			configPath,
			JSON.stringify({
				appSetupCommand: {
					mode: "parallel",
				},
			}),
		);

		await expect(
			resolveShopifyE2EConfig({ configPath, cwd }, {}),
		).rejects.toThrow(
			`Invalid Shopify E2E config at ${configPath}: appSetupCommand.command expected a string.`,
		);
	});

	it("throws app setup command mode errors with config file context", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "shopify-e2e-invalid-setup-mode-config-"),
		);
		const configPath = join(cwd, "shopify-e2e.config.json");

		await writeFile(
			configPath,
			JSON.stringify({
				appSetupCommand: {
					command: "php",
					mode: "parallel",
				},
			}),
		);

		await expect(
			resolveShopifyE2EConfig({ configPath, cwd }, {}),
		).rejects.toThrow(
			`Invalid Shopify E2E config at ${configPath}: appSetupCommand.mode expected one of: playwright, custom, shell.`,
		);
	});

	it("throws unsupported config file field errors with file context", async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), "shopify-e2e-invalid-config-"),
		);
		const configPath = join(cwd, "shopify-e2e.config.json");

		await writeFile(
			configPath,
			JSON.stringify({
				testCommand: {
					mode: "parallel",
				},
			}),
		);

		await expect(
			resolveShopifyE2EConfig({ configPath, cwd }, {}),
		).rejects.toThrow(
			`Invalid Shopify E2E config at ${configPath}: testCommand.mode expected one of: playwright, custom, shell.`,
		);
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

	it("returns an empty object when the env file is missing", () => {
		expect(parseEnvFile(join(tmpdir(), "shopify-e2e-missing.env"))).toEqual(
			{},
		);
	});
});
