import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	AuthMutationCommittedSignalError,
	defaultAuthDependencies,
	orchestrateAuth,
} from "../src/auth/auth-orchestrator.js";
import { CaptureSignalError } from "../src/auth/capture-role-state.js";
import { classifyAuthCommandFailure } from "../src/commands/auth.js";
import {
	ShopifyE2EInfrastructureError,
	ShopifyE2EPreflightError,
} from "../src/errors.js";
import { configuredOriginKey } from "../src/role-states/configured-origin.js";
import { createRoleStateStore } from "../src/role-states/role-state-store.js";
import type { PlaywrightStorageState } from "../src/storage-state/schema.js";
import {
	authOptions,
	createAuthFixtureScope,
	DEFAULT_ROLES,
	EMPTY_STORAGE_STATE,
	makePrompts,
	seedRoleState,
	withStubbedBrowser,
} from "./support/auth-command-fixture.js";

const { cleanup: cleanupFixtures, makeFixture } = createAuthFixtureScope();

const stateWithMarker = (marker: string): PlaywrightStorageState => ({
	cookies: [],
	origins: [
		{
			localStorage: [{ name: "marker", value: marker }],
			origin: "https://shop.example",
		},
	],
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await cleanupFixtures();
});

describe("role-only auth command orchestration", () => {
	it("lists configured readiness without prompts, Playwright, paths, or secrets", async () => {
		const fixture = await makeFixture();
		await seedRoleState(fixture, "admin");
		const report = vi.fn();
		const prompts = makePrompts();
		const dependencies = defaultAuthDependencies(prompts, report);
		const resolvePeer = vi.fn(dependencies.resolvePeer);

		await orchestrateAuth(
			authOptions(fixture, { action: "list", interactive: false }),
			{
				...dependencies,
				resolvePeer,
			},
		);

		expect(report.mock.calls).toEqual([
			["admin\tready"],
			["customer\tmissing"],
		]);
		expect(JSON.stringify(report.mock.calls)).not.toMatch(
			/cookie|storage-state|https:\/\/|\/private|secret/i,
		);
		expect(prompts.select).not.toHaveBeenCalled();
		expect(resolvePeer).not.toHaveBeenCalled();
	});

	it("reports a validly named stored role removed from config as orphaned", async () => {
		const fixture = await makeFixture();
		await seedRoleState(fixture, "removed-role", EMPTY_STORAGE_STATE, [
			...DEFAULT_ROLES,
			"removed-role",
		]);
		const report = vi.fn();

		await orchestrateAuth(
			authOptions(fixture, { action: "list", interactive: false }),
			defaultAuthDependencies(makePrompts(), report),
		);

		expect(report).toHaveBeenCalledWith("removed-role\torphaned");
	});

	it("captures an explicit role into its single state slot", async () => {
		const fixture = await makeFixture();
		const report = vi.fn();
		const prompts = makePrompts();
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, report),
		);

		await orchestrateAuth(
			authOptions(fixture, { action: "capture", role: "admin" }),
			dependencies,
		);

		const store = createRoleStateStore({
			dataRoot: fixture.dataDir,
			origin: "https://shop.example",
			roles: DEFAULT_ROLES,
		});
		expect(await store.resolve("admin")).toEqual({
			role: "admin",
			state: EMPTY_STORAGE_STATE,
		});
		expect(prompts.select).not.toHaveBeenCalled();
		expect(report).toHaveBeenCalledWith(
			"Saved role state for admin. Run `shopify-e2e run --role admin`.",
		);
	});

	it("capture omission prompts only from missing configured roles", async () => {
		const fixture = await makeFixture();
		await seedRoleState(fixture, "admin");
		const prompts = makePrompts({ selectValues: ["customer"] });
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, vi.fn()),
		);

		await orchestrateAuth(
			authOptions(fixture, { action: "capture" }),
			dependencies,
		);

		expect(prompts.select).toHaveBeenCalledWith(
			expect.objectContaining({
				choices: [{ name: "customer", value: "customer" }],
				message: "Which role should be captured?",
			}),
		);
	});

	it("rejects capture of ready state with refresh remediation before peer work", async () => {
		const fixture = await makeFixture();
		await seedRoleState(fixture, "admin");
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(makePrompts(), vi.fn()),
		);

		await expect(
			orchestrateAuth(
				authOptions(fixture, { action: "capture", role: "admin" }),
				dependencies,
			),
		).rejects.toThrow(/auth refresh --role admin/i);
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
	});

	it("rejects an unsafe explicit role without echoing it or resolving Playwright", async () => {
		const fixture = await makeFixture();
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(makePrompts(), vi.fn()),
		);
		const unsafeRole = "admin\nsecret=/private/state";

		const error = await orchestrateAuth(
			authOptions(fixture, { action: "capture", role: unsafeRole }),
			dependencies,
		).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ShopifyE2EPreflightError);
		expect(String(error)).not.toContain(unsafeRole);
		expect(String(error)).not.toContain("/private/state");
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
	});

	it("refreshes an explicit ready role atomically from its prior state", async () => {
		const fixture = await makeFixture();
		const before = stateWithMarker("before");
		const after = stateWithMarker("after");
		const store = await seedRoleState(fixture, "admin", before);
		const captureRoleState = vi.fn(async (args) => {
			expect(args.initialState).toEqual(before);
			return { state: after, status: "captured" as const };
		});
		const report = vi.fn();
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(makePrompts(), report),
			captureRoleState,
		);

		await orchestrateAuth(
			authOptions(fixture, { action: "refresh", role: "admin" }),
			dependencies,
		);

		expect((await store.resolve("admin")).state).toEqual(after);
		expect(report).toHaveBeenCalledWith("Refreshed role state for admin.");
	});

	it("refresh omission prompts only from ready configured roles", async () => {
		const fixture = await makeFixture();
		await seedRoleState(fixture, "admin");
		const prompts = makePrompts({ selectValues: ["admin"] });
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, vi.fn()),
		);

		await orchestrateAuth(
			authOptions(fixture, { action: "refresh" }),
			dependencies,
		);

		expect(prompts.select).toHaveBeenCalledWith(
			expect.objectContaining({
				choices: [{ name: "admin", value: "admin" }],
				message: "Which role should be refreshed?",
			}),
		);
	});

	it("rejects refresh of missing state with capture remediation before peer work", async () => {
		const fixture = await makeFixture();
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(makePrompts(), vi.fn()),
		);

		await expect(
			orchestrateAuth(
				authOptions(fixture, { action: "refresh", role: "customer" }),
				dependencies,
			),
		).rejects.toThrow(/auth capture --role customer/i);
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
	});

	it.each([
		"capture",
		"refresh",
	] as const)("rejects non-interactive %s before environment, prompts, or peer work", async (action) => {
		const fixture = await makeFixture();
		const prompts = makePrompts();
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, vi.fn()),
		);
		const loadEnvironment = vi.fn(dependencies.loadEnvironment);

		await expect(
			orchestrateAuth(
				authOptions(fixture, {
					action,
					interactive: false,
					role: "admin",
				}),
				{ ...dependencies, loadEnvironment },
			),
		).rejects.toThrow(/interactive terminal/i);
		expect(loadEnvironment).not.toHaveBeenCalled();
		expect(prompts.select).not.toHaveBeenCalled();
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
	});

	it("bare non-interactive auth directs callers to direct subcommands", async () => {
		const fixture = await makeFixture();
		const dependencies = defaultAuthDependencies(makePrompts(), vi.fn());
		const loadEnvironment = vi.fn(dependencies.loadEnvironment);

		await expect(
			orchestrateAuth(
				authOptions(fixture, { action: "menu", interactive: false }),
				{ ...dependencies, loadEnvironment },
			),
		).rejects.toThrow(/auth capture.*auth refresh.*auth remove.*auth list/i);
		expect(loadEnvironment).not.toHaveBeenCalled();
	});

	it("bare interactive auth exposes availability-aware actions and cancellation", async () => {
		const fixture = await makeFixture();
		await seedRoleState(fixture, "admin");
		const prompts = makePrompts({ selectValues: ["cancel"] });
		const report = vi.fn();

		await orchestrateAuth(
			authOptions(fixture),
			defaultAuthDependencies(prompts, report),
		);

		expect(vi.mocked(prompts.select).mock.calls[0]?.[0].choices).toEqual([
			{ disabled: false, name: "Capture", value: "capture" },
			{ disabled: false, name: "Refresh", value: "refresh" },
			{ disabled: false, name: "Remove", value: "remove" },
			{ name: "List", value: "list" },
			{ name: "Cancel", value: "cancel" },
		]);
		expect(report).toHaveBeenCalledWith(
			"Authentication menu cancelled; no role state changed.",
		);
	});

	it("bare auth routes List through the cached secret-free summary", async () => {
		const fixture = await makeFixture();
		const prompts = makePrompts({ selectValues: ["list"] });
		const report = vi.fn();
		const dependencies = defaultAuthDependencies(prompts, report);
		const resolvePeer = vi.fn(dependencies.resolvePeer);

		await orchestrateAuth(authOptions(fixture), {
			...dependencies,
			resolvePeer,
		});

		expect(report.mock.calls).toEqual([
			["admin\tmissing"],
			["customer\tmissing"],
		]);
		expect(resolvePeer).not.toHaveBeenCalled();
	});

	it("revalidates a stale capture prompt choice before browser work", async () => {
		const fixture = await makeFixture();
		const prompts = makePrompts();
		vi.mocked(prompts.select).mockImplementationOnce(async () => {
			await seedRoleState(fixture, "admin");
			return "admin";
		});
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, vi.fn()),
		);

		await expect(
			orchestrateAuth(
				authOptions(fixture, { action: "capture" }),
				dependencies,
			),
		).rejects.toThrow(/auth refresh --role admin/i);
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
	});

	it("rejects unsafe configured collisions with manual-cleanup guidance", async () => {
		const fixture = await makeFixture();
		await seedRoleState(fixture, "customer");
		const statesDirectory = join(
			fixture.dataDir,
			"origins",
			configuredOriginKey("https://shop.example"),
			"role-states",
		);
		await mkdir(join(fixture.projectRoot, "unsafe-target"));
		await symlink(
			join(fixture.projectRoot, "unsafe-target"),
			join(statesDirectory, "admin"),
		);
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(makePrompts(), vi.fn()),
		);

		await expect(
			orchestrateAuth(
				authOptions(fixture, { action: "capture", role: "admin" }),
				dependencies,
			),
		).rejects.toThrow(/unsafe.*manual cleanup/i);
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
	});

	it.each([
		"declined",
		"browser-closed",
	] as const)("%s capture cancellation leaves the role missing", async (reason) => {
		const fixture = await makeFixture();
		const report = vi.fn();
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(makePrompts(), report),
			vi.fn(async () => ({ reason, status: "cancelled" as const })),
		);

		await orchestrateAuth(
			authOptions(fixture, { action: "capture", role: "admin" }),
			dependencies,
		);

		const store = createRoleStateStore({
			dataRoot: fixture.dataDir,
			origin: "https://shop.example",
			roles: DEFAULT_ROLES,
		});
		expect(await store.list()).toContainEqual({
			role: "admin",
			status: "missing",
		});
		expect(report).toHaveBeenCalledWith(
			"Authentication capture cancelled; no role state changed.",
		);
	});

	it("fails a missing URL before config, state, prompts, or peer resolution", async () => {
		const fixture = await makeFixture();
		await rm(join(fixture.projectRoot, ".env"));
		const prompts = makePrompts();
		const dependencies = defaultAuthDependencies(prompts, vi.fn());
		const loadConfig = vi.fn(dependencies.loadConfig);
		const createStore = vi.fn(dependencies.createStore);

		await expect(
			orchestrateAuth(authOptions(fixture, { action: "list" }), {
				...dependencies,
				createStore,
				loadConfig,
			}),
		).rejects.toThrow(/SHOPIFY_STORE_URL.*\.env/i);
		expect(loadConfig).not.toHaveBeenCalled();
		expect(createStore).not.toHaveBeenCalled();
		expect(prompts.select).not.toHaveBeenCalled();
	});

	it("allows trusted config imports while package-owned list avoids Playwright", async () => {
		const fixture = await makeFixture(["admin"]);
		const sentinel = join(fixture.projectRoot, "trusted-import-ran");
		const helperPath = resolve(import.meta.dirname, "../src/config/public.ts");
		await writeFile(
			join(fixture.projectRoot, "shopify-e2e.config.ts"),
			`import { writeFileSync } from "node:fs"; import { defineShopifyE2EConfig } from ${JSON.stringify(helperPath)}; writeFileSync(${JSON.stringify(sentinel)}, "ran"); export default defineShopifyE2EConfig({ roles: ["admin"], testDir: "shopify-tests" });\n`,
		);
		const dependencies = defaultAuthDependencies(makePrompts(), vi.fn());
		const resolvePeer = vi.fn(dependencies.resolvePeer);

		await orchestrateAuth(
			authOptions(fixture, { action: "list", interactive: false }),
			{ ...dependencies, resolvePeer },
		);

		expect(resolvePeer).not.toHaveBeenCalled();
		expect(
			await import("node:fs/promises").then(({ readFile }) =>
				readFile(sentinel, "utf8"),
			),
		).toBe("ran");
	});
});

describe("auth command failure mapping", () => {
	it("preserves truthful post-commit interruption details", () => {
		const error = new AuthMutationCommittedSignalError(
			"SIGTERM",
			"Authentication interrupted after the role state changed.",
		);

		expect(classifyAuthCommandFailure(error, 143)).toEqual({
			exitCode: 143,
			message: "Authentication interrupted after the role state changed.",
		});
	});

	it.each([
		{ error: new CaptureSignalError("SIGINT"), expected: 130 },
		{ error: new CaptureSignalError("SIGTERM"), expected: 143 },
	])("maps role-state capture interruption to exit $expected", ({
		error,
		expected,
	}) => {
		expect(classifyAuthCommandFailure(error)).toEqual({
			exitCode: expected,
			message: "Authentication interrupted; no role state changed.",
		});
	});

	it("preserves sanitized known failures and hides unknown causes", () => {
		expect(
			classifyAuthCommandFailure(
				new ShopifyE2EPreflightError("actionable preflight"),
			),
		).toEqual({ exitCode: 2, message: "actionable preflight" });
		expect(
			classifyAuthCommandFailure(
				new ShopifyE2EInfrastructureError("safe infrastructure"),
			),
		).toEqual({ exitCode: 1, message: "safe infrastructure" });
		expect(classifyAuthCommandFailure(new Error("private cause"))).toEqual({
			exitCode: 1,
			message: "shopify-e2e could not complete authentication",
		});
	});
});
