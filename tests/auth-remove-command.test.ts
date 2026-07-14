import { afterEach, describe, expect, it, vi } from "vitest";

import {
	defaultAuthDependencies,
	orchestrateAuth,
} from "../src/auth/auth-orchestrator.js";
import { ShopifyE2EInfrastructureError } from "../src/errors.js";
import type { ProfileStore } from "../src/profiles/profile-store.js";
import {
	authOptions,
	createAuthFixtureScope,
	makePrompts,
	seedProfile,
	withStubbedBrowser,
} from "./support/auth-command-fixture.js";

const { cleanup: cleanupFixtures, makeFixture } = createAuthFixtureScope();

afterEach(async () => {
	vi.unstubAllEnvs();
	await cleanupFixtures();
});

describe("auth remove command orchestration", () => {
	it.each([
		{
			confirmCalls: 1,
			label: "no flags",
			profile: undefined,
			removableCalls: 1,
			selectCalls: 1,
			yes: undefined,
		},
		{
			confirmCalls: 1,
			label: "profile only",
			profile: "admin-primary",
			removableCalls: 1,
			selectCalls: 0,
			yes: undefined,
		},
		{
			confirmCalls: 0,
			label: "yes only",
			profile: undefined,
			removableCalls: 1,
			selectCalls: 1,
			yes: true,
		},
		{
			confirmCalls: 0,
			label: "profile and yes",
			profile: "admin-primary",
			removableCalls: 0,
			selectCalls: 0,
			yes: true,
		},
	])("removal prompts exactly for missing intent with $label", async ({
		confirmCalls,
		profile,
		removableCalls,
		selectCalls,
		yes,
	}) => {
		const fixture = await makeFixture();
		const prompts = makePrompts({ selectValues: ["admin-primary"] });
		const report = vi.fn();
		const removableProfiles = vi.fn(async () => ["admin-primary"]);
		const remove = vi.fn(async () => undefined);
		const store = { removableProfiles, remove } as unknown as ProfileStore;
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, report),
		);

		await orchestrateAuth(
			authOptions(fixture, {
				action: "remove",
				profile,
				yes,
			}),
			{ ...dependencies, createStore: vi.fn(() => store) },
		);

		expect(prompts.select).toHaveBeenCalledTimes(selectCalls);
		expect(prompts.confirm).toHaveBeenCalledTimes(confirmCalls);
		expect(removableProfiles).toHaveBeenCalledTimes(removableCalls);
		expect(remove).toHaveBeenCalledWith({
			name: "admin-primary",
			signal: expect.any(AbortSignal),
		});
		if (confirmCalls === 1) {
			expect(prompts.confirm).toHaveBeenCalledWith(
				expect.objectContaining({
					default: false,
					message:
						"Remove admin-primary? Locally saved browser authentication will be removed.",
				}),
			);
		}
		expect(report).toHaveBeenCalledWith("Removed saved profile admin-primary.");
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.loadChromium).not.toHaveBeenCalled();
		expect(dependencies.captureProfile).not.toHaveBeenCalled();
	});

	it("removes a seeded current-origin profile through the store boundary", async () => {
		const fixture = await makeFixture();
		const store = await seedProfile(fixture);
		const prompts = makePrompts();
		const report = vi.fn();
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, report),
		);

		await orchestrateAuth(
			authOptions(fixture, {
				action: "remove",
				interactive: false,
				profile: "admin-primary",
				yes: true,
			}),
			{ ...dependencies, createStore: vi.fn(() => store) },
		);

		expect(await store.list()).toEqual([]);
		expect(report).toHaveBeenCalledWith("Removed saved profile admin-primary.");
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.loadChromium).not.toHaveBeenCalled();
		expect(dependencies.captureProfile).not.toHaveBeenCalled();
	});

	it.each([
		{ label: "no flags", profile: undefined, yes: undefined },
		{ label: "profile only", profile: "admin-primary", yes: undefined },
		{ label: "yes only", profile: undefined, yes: true },
	])("non-interactive removal rejects $label before profile inspection", async ({
		profile,
		yes,
	}) => {
		const fixture = await makeFixture();
		const prompts = makePrompts();
		const removableProfiles = vi.fn(async () => ["admin-primary"]);
		const remove = vi.fn(async () => undefined);
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, vi.fn()),
		);

		await expect(
			orchestrateAuth(
				authOptions(fixture, {
					action: "remove",
					interactive: false,
					profile,
					yes,
				}),
				{
					...dependencies,
					createStore: vi.fn(
						() => ({ removableProfiles, remove }) as unknown as ProfileStore,
					),
				},
			),
		).rejects.toThrow(/--profile.*--yes/i);
		expect(removableProfiles).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(prompts.select).not.toHaveBeenCalled();
		expect(prompts.confirm).not.toHaveBeenCalled();
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.loadChromium).not.toHaveBeenCalled();
		expect(dependencies.captureProfile).not.toHaveBeenCalled();
	});

	it.each([
		{ label: "no flags", yes: undefined },
		{ label: "yes only", yes: true },
	])("direct interactive removal rejects zero candidates with $label before prompts", async ({
		yes,
	}) => {
		const fixture = await makeFixture();
		const prompts = makePrompts();
		const removableProfiles = vi.fn(async () => []);
		const remove = vi.fn(async () => undefined);
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, vi.fn()),
		);

		await expect(
			orchestrateAuth(authOptions(fixture, { action: "remove", yes }), {
				...dependencies,
				createStore: vi.fn(
					() => ({ removableProfiles, remove }) as unknown as ProfileStore,
				),
			}),
		).rejects.toThrow(/No removable saved profile is available/i);
		expect(removableProfiles).toHaveBeenCalledTimes(1);
		expect(prompts.select).not.toHaveBeenCalled();
		expect(prompts.confirm).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});

	it.each([
		"../escape",
		"guest",
		"unknown-profile",
	])("rejects explicit removal profile %s before confirmation", async (profile) => {
		const fixture = await makeFixture();
		const prompts = makePrompts();
		const removableProfiles = vi.fn(async () => ["admin-primary"]);
		const remove = vi.fn(async () => undefined);
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, vi.fn()),
		);

		await expect(
			orchestrateAuth(authOptions(fixture, { action: "remove", profile }), {
				...dependencies,
				createStore: vi.fn(
					() => ({ removableProfiles, remove }) as unknown as ProfileStore,
				),
			}),
		).rejects.toThrow(/unknown or cannot be removed/i);
		expect(removableProfiles).toHaveBeenCalledTimes(1);
		expect(prompts.confirm).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.loadChromium).not.toHaveBeenCalled();
		expect(dependencies.captureProfile).not.toHaveBeenCalled();
	});

	it("declining removal confirmation reports no change", async () => {
		const fixture = await makeFixture();
		const prompts = makePrompts({ confirmValue: false });
		const report = vi.fn();
		const removableProfiles = vi.fn(async () => ["admin-primary"]);
		const remove = vi.fn(async () => undefined);
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, report),
		);

		await orchestrateAuth(
			authOptions(fixture, {
				action: "remove",
				profile: "admin-primary",
			}),
			{
				...dependencies,
				createStore: vi.fn(
					() => ({ removableProfiles, remove }) as unknown as ProfileStore,
				),
			},
		);

		expect(remove).not.toHaveBeenCalled();
		expect(report).toHaveBeenCalledWith(
			"Authentication profile removal cancelled; no profile changed.",
		);
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.loadChromium).not.toHaveBeenCalled();
		expect(dependencies.captureProfile).not.toHaveBeenCalled();
	});

	it("bare auth enables removal and reuses cached removable candidates", async () => {
		const fixture = await makeFixture();
		const prompts = makePrompts({
			selectValues: ["remove", "orphaned-profile"],
		});
		const report = vi.fn();
		const list = vi.fn(async () => [
			{ name: "admin-primary", role: "admin", status: "runnable" as const },
		]);
		const removableProfiles = vi.fn(async () => [
			"admin-primary",
			"orphaned-profile",
		]);
		const remove = vi.fn(async () => undefined);
		const store = {
			list,
			removableProfiles,
			remove,
		} as unknown as ProfileStore;
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, report),
		);

		await orchestrateAuth(authOptions(fixture), {
			...dependencies,
			createStore: vi.fn(() => store),
		});

		const menuChoices = vi.mocked(prompts.select).mock.calls[0]?.[0].choices;
		expect(menuChoices).toContainEqual({
			disabled: false,
			name: "Remove a profile",
			value: "remove",
		});
		const removalChoices = vi.mocked(prompts.select).mock.calls[1]?.[0].choices;
		expect(removalChoices).toEqual([
			{ name: "admin-primary", value: "admin-primary" },
			{ name: "orphaned-profile", value: "orphaned-profile" },
		]);
		expect(list).toHaveBeenCalledTimes(1);
		expect(removableProfiles).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledWith({
			name: "orphaned-profile",
			signal: expect.any(AbortSignal),
		});
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.loadChromium).not.toHaveBeenCalled();
		expect(dependencies.captureProfile).not.toHaveBeenCalled();
	});

	it("preserves sanitized incomplete-cleanup failures without success output", async () => {
		const fixture = await makeFixture();
		const prompts = makePrompts();
		const report = vi.fn();
		const rawCause =
			"cookie=secret /private/profile/storage-state.json .tmp-remove-admin";
		const remove = vi.fn(async () => {
			throw new ShopifyE2EInfrastructureError(
				"Saved profile is unavailable, but local secret cleanup is incomplete",
				{ cause: new Error(rawCause) },
			);
		});
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, report),
		);

		const error = await orchestrateAuth(
			authOptions(fixture, {
				action: "remove",
				profile: "admin-primary",
				yes: true,
			}),
			{
				...dependencies,
				createStore: vi.fn(() => ({ remove }) as unknown as ProfileStore),
			},
		).catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ShopifyE2EInfrastructureError);
		expect(String(error)).toContain("local secret cleanup is incomplete");
		expect(String(error)).not.toContain(rawCause);
		expect(report).not.toHaveBeenCalled();
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.loadChromium).not.toHaveBeenCalled();
		expect(dependencies.captureProfile).not.toHaveBeenCalled();
	});

	it("awaits direct store removal after the command signal aborts", async () => {
		const fixture = await makeFixture();
		const prompts = makePrompts();
		const report = vi.fn();
		const controller = new AbortController();
		let resolveRemoval: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolveStarted) => {
			markStarted = resolveStarted;
		});
		const cleanup = new Promise<void>((resolveCleanup) => {
			resolveRemoval = resolveCleanup;
		});
		const remove = vi.fn(
			async ({ signal }: { readonly signal?: AbortSignal }) => {
				expect(signal).toBe(controller.signal);
				markStarted?.();
				await cleanup;
			},
		);
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, report),
		);
		const operation = orchestrateAuth(
			authOptions(fixture, {
				action: "remove",
				interactive: false,
				profile: "admin-primary",
				signal: controller.signal,
				yes: true,
			}),
			{
				...dependencies,
				createStore: vi.fn(() => ({ remove }) as unknown as ProfileStore),
			},
		);

		await started;
		controller.abort("SIGINT");
		resolveRemoval?.();
		await expect(operation).resolves.toBeUndefined();
		expect(report).toHaveBeenCalledWith("Removed saved profile admin-primary.");
		expect(dependencies.resolvePeer).not.toHaveBeenCalled();
		expect(dependencies.loadChromium).not.toHaveBeenCalled();
		expect(dependencies.captureProfile).not.toHaveBeenCalled();
	});
});
