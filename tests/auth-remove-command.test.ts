import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	defaultAuthDependencies,
	orchestrateAuth,
} from "../src/auth/auth-orchestrator.js";
import { ShopifyE2EInfrastructureError } from "../src/errors.js";
import { configuredOriginKey } from "../src/role-states/configured-origin.cjs";
import {
	createRoleStateStore,
	type RoleStateStore,
} from "../src/role-states/role-state-store.js";
import {
	authOptions,
	createAuthFixtureScope,
	DEFAULT_ROLES,
	makePrompts,
	seedRoleState,
} from "./support/auth-command-fixture.js";

const { cleanup: cleanupFixtures, makeFixture } = createAuthFixtureScope();

afterEach(async () => {
	vi.unstubAllEnvs();
	await cleanupFixtures();
});

describe("role-only auth remove matrix", () => {
	it.each([
		{
			confirmCalls: 1,
			label: "no flags",
			role: undefined,
			selectCalls: 1,
			yes: undefined,
		},
		{
			confirmCalls: 1,
			label: "role only",
			role: "admin",
			selectCalls: 0,
			yes: undefined,
		},
		{
			confirmCalls: 0,
			label: "yes only",
			role: undefined,
			selectCalls: 1,
			yes: true,
		},
		{
			confirmCalls: 0,
			label: "role and yes",
			role: "admin",
			selectCalls: 0,
			yes: true,
		},
	])("interactive removal follows the exact $label matrix", async ({
		confirmCalls,
		role,
		selectCalls,
		yes,
	}) => {
		const fixture = await makeFixture();
		const store = await seedRoleState(fixture, "admin");
		const prompts = makePrompts({ selectValues: ["admin"] });
		const report = vi.fn();

		await orchestrateAuth(
			authOptions(fixture, { action: "remove", role, yes }),
			defaultAuthDependencies(prompts, report),
		);

		expect(prompts.select).toHaveBeenCalledTimes(selectCalls);
		expect(prompts.confirm).toHaveBeenCalledTimes(confirmCalls);
		if (confirmCalls === 1) {
			expect(prompts.confirm).toHaveBeenCalledWith(
				expect.objectContaining({
					default: false,
					message:
						"Remove role state for admin? Locally saved browser authentication will be removed.",
				}),
			);
		}
		expect(await store.list()).toContainEqual({
			role: "admin",
			status: "missing",
		});
		expect(report).toHaveBeenCalledWith("Removed role state for admin.");
	});

	it.each([
		{ label: "no flags", role: undefined, yes: undefined },
		{ label: "role only", role: "admin", yes: undefined },
		{ label: "yes only", role: undefined, yes: true },
	])("non-interactive removal rejects $label before environment or state inspection", async ({
		role,
		yes,
	}) => {
		const fixture = await makeFixture();
		const prompts = makePrompts();
		const dependencies = defaultAuthDependencies(prompts, vi.fn());
		const loadEnvironment = vi.fn(dependencies.loadEnvironment);
		const createStore = vi.fn(dependencies.createStore);

		await expect(
			orchestrateAuth(
				authOptions(fixture, {
					action: "remove",
					interactive: false,
					role,
					yes,
				}),
				{ ...dependencies, createStore, loadEnvironment },
			),
		).rejects.toThrow(/--role.*--yes/i);
		expect(loadEnvironment).not.toHaveBeenCalled();
		expect(createStore).not.toHaveBeenCalled();
		expect(prompts.select).not.toHaveBeenCalled();
		expect(prompts.confirm).not.toHaveBeenCalled();
	});

	it("non-interactive explicit --role plus --yes removes without prompts", async () => {
		const fixture = await makeFixture();
		const store = await seedRoleState(fixture, "admin");
		const prompts = makePrompts();

		await orchestrateAuth(
			authOptions(fixture, {
				action: "remove",
				interactive: false,
				role: "admin",
				yes: true,
			}),
			defaultAuthDependencies(prompts, vi.fn()),
		);

		expect(await store.list()).toContainEqual({
			role: "admin",
			status: "missing",
		});
		expect(prompts.select).not.toHaveBeenCalled();
		expect(prompts.confirm).not.toHaveBeenCalled();
	});

	it("removes a path-safe invalid configured role", async () => {
		const fixture = await makeFixture();
		const store = await seedRoleState(fixture, "admin");
		await writeFile(
			join(
				fixture.dataDir,
				"origins",
				configuredOriginKey("https://shop.example"),
				"role-states",
				"admin",
				"storage-state.json",
			),
			"not json",
		);

		await orchestrateAuth(
			authOptions(fixture, { action: "remove", role: "admin", yes: true }),
			defaultAuthDependencies(makePrompts(), vi.fn()),
		);

		expect(await store.list()).toContainEqual({
			role: "admin",
			status: "missing",
		});
	});

	it("removes a path-safe orphaned role without treating it as configured", async () => {
		const fixture = await makeFixture();
		await seedRoleState(fixture, "removed-role", undefined, [
			...DEFAULT_ROLES,
			"removed-role",
		]);
		const currentStore = createRoleStateStore({
			dataRoot: fixture.dataDir,
			origin: "https://shop.example",
			roles: DEFAULT_ROLES,
		});
		expect(await currentStore.list()).toContainEqual({
			role: "removed-role",
			status: "orphaned",
		});

		await orchestrateAuth(
			authOptions(fixture, {
				action: "remove",
				interactive: false,
				role: "removed-role",
				yes: true,
			}),
			defaultAuthDependencies(makePrompts(), vi.fn()),
		);

		expect(await currentStore.removableRoles()).not.toContain("removed-role");
	});

	it("never removes an unsafe configured collision and requires manual cleanup", async () => {
		const fixture = await makeFixture();
		await seedRoleState(fixture, "customer");
		const statesDirectory = join(
			fixture.dataDir,
			"origins",
			configuredOriginKey("https://shop.example"),
			"role-states",
		);
		const target = join(fixture.projectRoot, "unsafe-target");
		await mkdir(target);
		await symlink(target, join(statesDirectory, "admin"));

		await expect(
			orchestrateAuth(
				authOptions(fixture, { action: "remove", role: "admin", yes: true }),
				defaultAuthDependencies(makePrompts(), vi.fn()),
			),
		).rejects.toThrow(/unsafe.*manual cleanup/i);
	});

	it.each([
		undefined,
		true,
	])("interactive omitted role rejects zero candidates without opening an empty prompt (yes=%s)", async (yes) => {
		const fixture = await makeFixture();
		const prompts = makePrompts();

		await expect(
			orchestrateAuth(
				authOptions(fixture, { action: "remove", yes }),
				defaultAuthDependencies(prompts, vi.fn()),
			),
		).rejects.toThrow(/no removable role state/i);
		expect(prompts.select).not.toHaveBeenCalled();
		expect(prompts.confirm).not.toHaveBeenCalled();
	});

	it("declining the default-no confirmation preserves state", async () => {
		const fixture = await makeFixture();
		const store = await seedRoleState(fixture, "admin");
		const prompts = makePrompts({ confirmValue: false });
		const report = vi.fn();

		await orchestrateAuth(
			authOptions(fixture, { action: "remove", role: "admin" }),
			defaultAuthDependencies(prompts, report),
		);

		expect((await store.resolve("admin")).role).toBe("admin");
		expect(report).toHaveBeenCalledWith(
			"Authentication role-state removal cancelled; no role state changed.",
		);
	});

	it("revalidates a stale prompted target at the store mutation boundary", async () => {
		const fixture = await makeFixture();
		const store = await seedRoleState(fixture, "admin");
		const prompts = makePrompts();
		vi.mocked(prompts.select).mockImplementationOnce(async () => {
			await store.remove({ role: "admin" });
			return "admin";
		});

		await expect(
			orchestrateAuth(
				authOptions(fixture, { action: "remove", yes: true }),
				defaultAuthDependencies(prompts, vi.fn()),
			),
		).rejects.toThrow(/unknown or cannot be removed/i);
	});

	it("preserves sanitized incomplete-cleanup failures without success output", async () => {
		const fixture = await makeFixture();
		const prompts = makePrompts();
		const report = vi.fn();
		const rawCause = "cookie=secret /private/state .tmp-remove-admin";
		const remove = vi.fn(async () => {
			throw new ShopifyE2EInfrastructureError(
				"Role state is unavailable, but local secret cleanup is incomplete",
				{ cause: new Error(rawCause) },
			);
		});
		const store = {
			list: vi.fn(async () => [{ role: "admin", status: "ready" as const }]),
			removableRoles: vi.fn(async () => ["admin"]),
			remove,
		} as unknown as RoleStateStore;
		const dependencies = defaultAuthDependencies(prompts, report);

		const error = await orchestrateAuth(
			authOptions(fixture, { action: "remove", role: "admin", yes: true }),
			{ ...dependencies, createStore: vi.fn(() => store) },
		).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ShopifyE2EInfrastructureError);
		expect(String(error)).toContain("local secret cleanup is incomplete");
		expect(String(error)).not.toContain(rawCause);
		expect(report).not.toHaveBeenCalled();
	});
});
