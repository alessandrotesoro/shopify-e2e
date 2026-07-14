import { spawnSync } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PACKAGE_ROOT } from "../src/package-root.js";
import { createGeneratedPlaywrightConfig } from "../src/playwright/generated-config.js";
import {
	EMPTY_STORAGE_STATE,
	type ProfileSelection,
} from "../src/profiles/profile-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("role-scoped generated Playwright config", () => {
	it("embeds the selected state by value and mandatory exact role grep", async () => {
		const root = await mkdtemp(join(tmpdir(), "shopify-e2e-generated-role-"));
		temporaryDirectories.push(root);
		const testDir = join(root, "shopify-tests");
		await mkdir(testDir);
		await writeFile(join(testDir, "admin.spec.ts"), "// candidate\n");

		const state = {
			cookies: [
				{
					domain: "shop.example",
					expires: -1,
					httpOnly: true,
					name: "session",
					path: "/",
					sameSite: "Lax" as const,
					secure: true,
					value: "frozen-value",
				},
			],
			origins: [],
		};
		const config = await createGeneratedPlaywrightConfig({
			packageRoot: PACKAGE_ROOT,
			projectRoot: root,
			selection: {
				kind: "saved",
				name: "admin-primary",
				role: "admin",
				state,
			},
			testDir,
		});
		const firstCookie = state.cookies[0];
		if (!firstCookie) throw new Error("Expected seeded cookie");
		firstCookie.value = "refreshed-after-selection";
		try {
			const source = await readFile(config.configPath, "utf8");
			expect(source).toContain(`testDir: ${JSON.stringify(testDir)}`);
			expect(source).toContain("workers: 1");
			expect(source).toContain('\\"value\\":\\"frozen-value\\"');
			expect(source).not.toContain("refreshed-after-selection");
			expect(source).toContain("@shopify-e2e-role-admin");
			expect(source).not.toContain("storage-state.json");
			if (process.platform !== "win32") {
				expect((await stat(dirname(config.configPath))).mode & 0o777).toBe(
					0o700,
				);
				expect((await stat(config.configPath)).mode & 0o777).toBe(0o600);
			}
		} finally {
			await config.cleanup();
		}
		await expect(access(dirname(config.configPath))).rejects.toThrow();
	});

	it("writes explicit empty state for an unauthenticated role", async () => {
		const root = await mkdtemp(join(tmpdir(), "shopify-e2e-generated-guest-"));
		temporaryDirectories.push(root);
		const testDir = join(root, "shopify-tests");
		await mkdir(testDir);

		const config = await createGeneratedPlaywrightConfig({
			packageRoot: PACKAGE_ROOT,
			projectRoot: root,
			selection: {
				kind: "unauthenticated",
				name: "guest",
				role: "guest",
				state: EMPTY_STORAGE_STATE,
			},
			testDir,
		});
		try {
			expect(await readFile(config.configPath, "utf8")).toContain(
				'storageState: JSON.parse("{\\"cookies\\":[],\\"origins\\":[]}")',
			);
		} finally {
			await config.cleanup();
		}
	});

	it("round-trips own __proto__ IndexedDB keys through JSON.parse", async () => {
		const root = await mkdtemp(join(tmpdir(), "shopify-e2e-generated-proto-"));
		temporaryDirectories.push(root);
		const testDir = join(root, "shopify-tests");
		await mkdir(testDir);
		const state = JSON.parse(`{
			"cookies": [],
			"origins": [{
				"origin": "https://shop.example",
				"localStorage": [],
				"indexedDB": [{
					"name": "account",
					"version": 1,
					"stores": [{
						"name": "sessions",
						"autoIncrement": false,
						"indexes": [],
						"records": [{"key": "current", "value": {"__proto__": {"authenticated": true}}}]
					}]
				}]
			}]
		}`) as ProfileSelection["state"];

		const config = await createGeneratedPlaywrightConfig({
			packageRoot: PACKAGE_ROOT,
			projectRoot: root,
			selection: {
				kind: "saved",
				name: "customer-primary",
				role: "customer",
				state,
			},
			testDir,
		});
		try {
			const source = await readFile(config.configPath, "utf8");
			expect(source).toContain("storageState: JSON.parse(");
			const probe = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					`const loaded = await import(process.argv[1]);
const value = loaded.default.use.storageState.origins[0].indexedDB[0].stores[0].records[0].value;
process.stdout.write(JSON.stringify({ hasOwn: Object.hasOwn(value, "__proto__"), ordinaryPrototype: Object.getPrototypeOf(value) === Object.prototype, value: Object.getOwnPropertyDescriptor(value, "__proto__")?.value }));`,
					pathToFileURL(config.configPath).href,
				],
				{ encoding: "utf8" },
			);
			expect(probe.status, probe.stderr).toBe(0);
			const result = JSON.parse(probe.stdout) as {
				hasOwn: boolean;
				ordinaryPrototype: boolean;
				value: unknown;
			};
			expect(result.hasOwn).toBe(true);
			expect(result.ordinaryPrototype).toBe(true);
			expect(result.value).toEqual({
				authenticated: true,
			});
		} finally {
			await config.cleanup();
		}
	});

	it.each([
		"project",
		"package",
	] as const)("rejects a system temp root physically contained in the %s before creating secret state", async (boundary) => {
		const root = await mkdtemp(
			join(tmpdir(), `shopify-e2e-generated-boundary-${boundary}-`),
		);
		temporaryDirectories.push(root);
		const projectRoot = join(root, "consumer");
		const packageRoot = join(root, "installed-package");
		await mkdir(projectRoot);
		await mkdir(packageRoot);
		const testDir = join(projectRoot, "shopify-tests");
		await mkdir(testDir);
		const temporaryRoot = join(
			boundary === "project" ? projectRoot : packageRoot,
			"runtime-temp",
		);
		await mkdir(temporaryRoot);
		vi.stubEnv("TMPDIR", temporaryRoot);
		vi.stubEnv("TMP", temporaryRoot);
		vi.stubEnv("TEMP", temporaryRoot);

		await expect(
			createGeneratedPlaywrightConfig({
				packageRoot,
				projectRoot,
				selection: {
					kind: "saved",
					name: "customer-primary",
					role: "customer",
					state: {
						cookies: [],
						origins: [],
					},
				},
				testDir,
			}),
		).rejects.toThrow(/temporary directory.*outside/i);
		expect(await readdir(temporaryRoot)).toEqual([]);
	});
});
