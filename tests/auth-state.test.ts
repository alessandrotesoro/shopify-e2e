import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserContext, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";

import { restoreAuthState, saveAuthState } from "../src/auth-state.js";
import type { ResolvedShopifyE2EConfig } from "../src/shopify-e2e-config.js";

function configFor(authStatePath: string): ResolvedShopifyE2EConfig {
	return {
		appUrl: "https://app.test",
		authStatePath,
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
}

function fakePage(): Page {
	let currentUrl = "about:blank";

	return {
		evaluate: vi.fn(async () => undefined),
		goto: vi.fn(async (url: string) => {
			currentUrl = url;
			return null;
		}),
		isClosed: vi.fn(() => false),
		url: vi.fn(() => currentUrl),
	} as unknown as Page;
}

describe("auth state", () => {
	it("skips restore when no auth-state file exists", async () => {
		const dir = await mkdtemp(join(tmpdir(), "shopify-e2e-auth-"));
		const authStatePath = join(dir, "missing.json");
		const context = {
			addCookies: vi.fn(),
		} as unknown as BrowserContext;

		await expect(
			restoreAuthState(configFor(authStatePath), context, fakePage()),
		).resolves.toEqual({
			path: authStatePath,
			restored: false,
		});
		expect(context.addCookies).not.toHaveBeenCalled();
	});

	it("restores cookies, localStorage, and returns to Shopify Admin", async () => {
		const dir = await mkdtemp(join(tmpdir(), "shopify-e2e-auth-"));
		const authStatePath = join(dir, "state.json");
		const storageState = {
			cookies: [
				{
					domain: ".myshopify.com",
					name: "_shopify_e2e",
					path: "/",
					value: "1",
				},
			],
			origins: [
				{
					localStorage: [{ name: "shopify.example", value: "ready" }],
					origin: "https://example.myshopify.com",
				},
			],
		};
		await writeFile(authStatePath, JSON.stringify(storageState), "utf8");

		const page = fakePage();
		const context = {
			addCookies: vi.fn(async () => undefined),
		} as unknown as BrowserContext;

		await expect(
			restoreAuthState(configFor(authStatePath), context, page),
		).resolves.toEqual({
			path: authStatePath,
			restored: true,
		});

		expect(context.addCookies).toHaveBeenCalledWith(storageState.cookies);
		expect(page.goto).toHaveBeenNthCalledWith(
			1,
			"https://example.myshopify.com",
			expect.objectContaining({ waitUntil: "domcontentloaded" }),
		);
		expect(page.evaluate).toHaveBeenCalledWith(
			expect.any(Function),
			storageState.origins[0]?.localStorage,
		);
		expect(page.goto).toHaveBeenLastCalledWith(
			"https://admin.shopify.com/store/example",
			expect.objectContaining({ waitUntil: "domcontentloaded" }),
		);
	});

	it("creates the auth-state directory when saving", async () => {
		const dir = await mkdtemp(join(tmpdir(), "shopify-e2e-auth-"));
		const authStatePath = join(dir, "nested", "state.json");
		const context = {
			storageState: vi.fn(async ({ path }: { path: string }) => {
				await writeFile(
					path,
					JSON.stringify({ cookies: [], origins: [] }),
					"utf8",
				);
			}),
		} as unknown as BrowserContext;

		await expect(
			saveAuthState(configFor(authStatePath), context),
		).resolves.toEqual({
			path: authStatePath,
		});
		await expect(readFile(authStatePath, "utf8")).resolves.toContain(
			"cookies",
		);
		expect(context.storageState).toHaveBeenCalledWith({
			path: authStatePath,
		});
	});

	it("rejects malformed auth-state JSON with file context", async () => {
		const dir = await mkdtemp(join(tmpdir(), "shopify-e2e-auth-"));
		const authStatePath = join(dir, "state.json");
		const context = {
			addCookies: vi.fn(),
		} as unknown as BrowserContext;

		await writeFile(
			authStatePath,
			JSON.stringify({
				origins: [
					{
						localStorage: [{ name: "shopify.example", value: 1 }],
						origin: "https://example.myshopify.com",
					},
				],
			}),
			"utf8",
		);

		await expect(
			restoreAuthState(configFor(authStatePath), context, fakePage()),
		).rejects.toThrow(`Invalid auth state at ${authStatePath}: origins`);
		expect(context.addCookies).not.toHaveBeenCalled();
	});
});
