import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
	defineShopifyE2EConfig,
	isDefinedShopifyE2EConfig,
} from "../src/config/define-config.cjs";
import { createPlaywrightExecutionContext } from "../src/playwright/execution-context.cjs";

describe("defineShopifyE2EConfig", () => {
	it.each([
		{
			args: ["--input-type=module"],
			label: "ESM import",
			source:
				'import { defineShopifyE2EConfig } from "@sematico/shopify-e2e/config"; console.log(defineShopifyE2EConfig({ testDir: "tests", roles: ["admin"] }).roles[0]);',
		},
		{
			args: [],
			label: "CommonJS require",
			source:
				'const { defineShopifyE2EConfig } = require("@sematico/shopify-e2e/config"); console.log(defineShopifyE2EConfig({ testDir: "tests", roles: ["admin"] }).roles[0]);',
		},
	])("loads the public helper through $label", ({ args, source }) => {
		const result = spawnSync(process.execPath, [...args, "--eval", source], {
			cwd: resolve(import.meta.dirname, ".."),
			encoding: "utf8",
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe("admin");
	});

	it("emits no runtime Playwright dependency from the public helper closure", () => {
		const projectRoot = resolve(import.meta.dirname, "..");
		const emittedClosure = [
			readFileSync(resolve(projectRoot, "dist/config/public.cjs"), "utf8"),
			readFileSync(
				resolve(projectRoot, "dist/config/define-config.cjs"),
				"utf8",
			),
			readFileSync(resolve(projectRoot, "dist/roles/role-name.cjs"), "utf8"),
		].join("\n");

		expect(emittedClosure).not.toContain("@playwright/test");
	});

	it("preserves unprotected Playwright values while copying the config and use", () => {
		const reporter: [["html", { outputFolder: string }]] = [
			["html", { outputFolder: "reports" }],
		];
		const testMatch = /shopify\/.+\.spec\.ts$/;
		const metadata = { product: "shopify" };
		const expectSettings = { timeout: 12_000 };
		const use = {
			baseURL: "https://shop.example",
			screenshot: "only-on-failure" as const,
			trace: "retain-on-failure" as const,
			video: "on-first-retry" as const,
		};
		const input = {
			expect: expectSettings,
			fullyParallel: true,
			metadata,
			reporter,
			retries: 2,
			roles: ["admin", "customer"],
			testDir: "shopify-tests",
			testMatch,
			use,
		};

		const config = defineShopifyE2EConfig(input);

		expect(config).not.toBe(input);
		expect(config.use).not.toBe(use);
		expect(config.roles).toEqual(["admin", "customer"]);
		expect(config.reporter).toBe(reporter);
		expect(config.testMatch).toBe(testMatch);
		expect(config.metadata).toBe(metadata);
		expect(config.expect).toBe(expectSettings);
		expect(config.use).toEqual(use);
		expect(isDefinedShopifyE2EConfig(config)).toBe(true);
		expect(Object.getOwnPropertySymbols(config)).toHaveLength(1);
		expect(Object.keys(config)).not.toContain(
			Object.getOwnPropertySymbols(config)[0],
		);
	});

	it.each([
		["projects", { projects: [] }],
		["workers", { workers: 2 }],
		["grep", { grep: /checkout/ }],
		["grepInvert", { grepInvert: /draft/ }],
	])("rejects the protected %s setting", (setting, protectedValue) => {
		expect(() =>
			defineShopifyE2EConfig({
				roles: ["admin"],
				testDir: "shopify-tests",
				...protectedValue,
			} as never),
		).toThrow(new RegExp(setting, "i"));
	});

	it("rejects use.storageState while preserving other use values", () => {
		expect(() =>
			defineShopifyE2EConfig({
				roles: ["admin"],
				testDir: "shopify-tests",
				use: { baseURL: "https://shop.example", storageState: "state.json" },
			} as never),
		).toThrow(/use\.storageState/i);
	});

	it.each([
		["empty", []],
		["duplicate", ["admin", "admin"]],
		["malformed", ["Admin User"]],
	])("rejects a %s roles list", (_label, roles) => {
		expect(() =>
			defineShopifyE2EConfig({ roles, testDir: "shopify-tests" } as never),
		).toThrow(/roles|role name/i);
	});

	it("rejects accessor and symbol-bearing role lists without evaluating them", () => {
		const accessorRoles: string[] = [];
		Object.defineProperty(accessorRoles, "0", {
			enumerable: true,
			get() {
				throw new Error("accessor secret");
			},
		});
		Object.defineProperty(accessorRoles, "length", { value: 1 });
		const symbolRoles = ["admin"];
		Object.defineProperty(symbolRoles, Symbol("hidden"), { value: "customer" });

		for (const roles of [accessorRoles, symbolRoles]) {
			let error: unknown;
			try {
				defineShopifyE2EConfig({ roles, testDir: "shopify-tests" } as never);
			} catch (cause) {
				error = cause;
			}
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/roles/i);
			expect((error as Error).message).not.toMatch(/accessor secret/i);
		}
	});

	it("allows protected keys only when their data value is undefined", () => {
		const config = defineShopifyE2EConfig({
			grep: undefined,
			grepInvert: undefined,
			projects: undefined,
			roles: ["admin"],
			testDir: "shopify-tests",
			use: { storageState: undefined },
			workers: undefined,
		} as never);

		expect(isDefinedShopifyE2EConfig(config)).toBe(true);
	});

	it("does not brand raw or spread-cloned config objects", () => {
		const config = defineShopifyE2EConfig({
			roles: ["admin"],
			testDir: "shopify-tests",
		});

		expect(
			isDefinedShopifyE2EConfig({
				roles: ["admin"],
				testDir: "shopify-tests",
			}),
		).toBe(false);
		expect(isDefinedShopifyE2EConfig({ ...config })).toBe(false);
	});

	it("overlays only the frozen child-time settings and preserves object identities", async () => {
		const { mkdir, mkdtemp, realpath, rm, writeFile } = await import(
			"node:fs/promises"
		);
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const projectRoot = await realpath(
			await mkdtemp(join(tmpdir(), "shopify-e2e-helper-overlay-")),
		);
		const configPath = join(projectRoot, "shopify-e2e.config.ts");
		const testDir = join(projectRoot, "frozen-tests");
		await mkdir(testDir);
		await writeFile(configPath, "export default {};\n");
		const context = await createPlaywrightExecutionContext({
			configPath,
			normalizedOrigin: "https://shop.example",
			projectRoot,
			role: "admin",
			state: { cookies: [], origins: [] },
			testDir,
		});
		const previousContext = process.env.SHOPIFY_E2E_EXECUTION_CONTEXT;
		const previousOrigin = process.env.SHOPIFY_STORE_URL;
		process.env.SHOPIFY_E2E_EXECUTION_CONTEXT = context.contextPath;
		process.env.SHOPIFY_STORE_URL = "https://shop.example/path";

		try {
			const reporter: [["line"]] = [["line"]];
			const webServer = [{ command: "serve", port: 3000 }];
			const metadata = { lane: "shopify" };
			const expectSettings = { timeout: 9_000 };
			const testMatch = /checkout\.spec\.ts$/;
			const runtimeFunction = () => undefined;
			const config = defineShopifyE2EConfig({
				customRuntimeFunction: runtimeFunction,
				expect: expectSettings,
				fullyParallel: true,
				metadata,
				reporter,
				roles: ["admin", "customer"],
				testDir: "different-on-repeat",
				testMatch,
				use: { screenshot: "only-on-failure", trace: "retain-on-failure" },
				webServer,
			} as never);

			expect(config).toMatchObject({
				fullyParallel: true,
				grep: expect.any(RegExp),
				testDir,
				workers: 1,
			});
			expect(config.reporter).toBe(reporter);
			expect(config.webServer).toBe(webServer);
			expect(config.metadata).toBe(metadata);
			expect(config.expect).toBe(expectSettings);
			expect(config.testMatch).toBe(testMatch);
			expect(
				(config as unknown as Record<string, unknown>).customRuntimeFunction,
			).toBe(runtimeFunction);
			expect(config.grep).toEqual(/(?:^|\s)@shopify-e2e-role-admin(?=$|\s)/);
			expect(config.use).toEqual({
				screenshot: "only-on-failure",
				storageState: { cookies: [], origins: [] },
				trace: "retain-on-failure",
			});
			expect(config.use?.storageState).not.toBe(context.contextPath);
			expect(() =>
				defineShopifyE2EConfig({
					roles: ["customer"],
					testDir: "shopify-tests",
				}),
			).toThrow(/selected role.*roles/i);
		} finally {
			if (previousContext === undefined)
				delete process.env.SHOPIFY_E2E_EXECUTION_CONTEXT;
			else process.env.SHOPIFY_E2E_EXECUTION_CONTEXT = previousContext;
			if (previousOrigin === undefined) delete process.env.SHOPIFY_STORE_URL;
			else process.env.SHOPIFY_STORE_URL = previousOrigin;
			await context.cleanup();
			await rm(projectRoot, { force: true, recursive: true });
		}
	});
});
