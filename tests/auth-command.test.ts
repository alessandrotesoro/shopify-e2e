import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	type AuthOrchestratorDependencies,
	type AuthOrchestratorOptions,
	defaultAuthDependencies,
	orchestrateAuth,
} from "../src/auth/auth-orchestrator.js";
import { CaptureSignalError } from "../src/auth/capture-profile.js";
import { classifyAuthCommandFailure } from "../src/commands/auth.js";
import {
	ShopifyE2EInfrastructureError,
	ShopifyE2EPreflightError,
} from "../src/errors.js";
import { configuredOriginKey } from "../src/profiles/configured-origin.js";
import type { PlaywrightStorageState } from "../src/profiles/profile-schema.js";
import {
	createProfileStore,
	EMPTY_STORAGE_STATE,
	type ProfileStore,
} from "../src/profiles/profile-store.js";
import type { PromptFunctions } from "../src/prompts/inquirer.js";

const temporaryDirectories: string[] = [];
const packageRoot = resolve(import.meta.dirname, "..");

const DEFAULT_ROLES = {
	admin: { authentication: "required" as const },
	guest: { authentication: "none" as const },
};

const makeFixture = async (
	roles: Readonly<
		Record<string, { readonly authentication: "none" | "required" }>
	> = DEFAULT_ROLES,
): Promise<{
	readonly dataDir: string;
	readonly projectRoot: string;
}> => {
	const projectRoot = await mkdtemp(
		join(tmpdir(), "shopify-e2e-auth-project-"),
	);
	const dataParent = await realpath(
		await mkdtemp(join(tmpdir(), "shopify-e2e-auth-data-")),
	);
	temporaryDirectories.push(projectRoot, dataParent);
	await mkdir(join(projectRoot, "shopify-tests"));
	await writeFile(
		join(projectRoot, "shopify-e2e.config.ts"),
		`export default ${JSON.stringify({ roles, testDir: "shopify-tests" })};\n`,
	);
	await writeFile(
		join(projectRoot, ".env"),
		"SHOPIFY_STORE_URL=https://shop.example/path?ignored=yes\n",
	);
	return {
		dataDir: join(dataParent, "application-data"),
		projectRoot: await realpath(projectRoot),
	};
};

interface MakePromptsOptions {
	readonly confirmValue?: boolean;
	readonly inputValue?: string;
	readonly selectValues?: unknown[];
}

const makePrompts = ({
	confirmValue = true,
	inputValue = "admin-primary",
	selectValues = [],
}: MakePromptsOptions = {}): PromptFunctions => ({
	confirm: vi.fn(async () => confirmValue),
	input: vi.fn(async () => inputValue),
	select: vi.fn(async () => selectValues.shift()) as PromptFunctions["select"],
});

const stateWithMarker = (marker: string): PlaywrightStorageState => ({
	cookies: [],
	origins: [
		{
			localStorage: [{ name: "marker", value: marker }],
			origin: "https://shop.example",
		},
	],
});

const seedProfile = async (
	fixture: Awaited<ReturnType<typeof makeFixture>>,
	name = "admin-primary",
	state: PlaywrightStorageState = EMPTY_STORAGE_STATE,
): Promise<ProfileStore> => {
	const store = createProfileStore({
		dataRoot: fixture.dataDir,
		origin: "https://shop.example",
		roles: DEFAULT_ROLES,
	});
	await store.capture({ name, role: "admin", state });
	return store;
};

const withStubbedBrowser = (
	dependencies: ReturnType<typeof defaultAuthDependencies>,
	captureProfile: AuthOrchestratorDependencies["captureProfile"] = vi.fn(
		async () => ({
			state: EMPTY_STORAGE_STATE,
			status: "captured" as const,
		}),
	),
) => ({
	...dependencies,
	captureProfile,
	loadChromium: vi.fn(async () => ({
		executablePath: vi.fn(() => "/consumer/chromium"),
		launch: vi.fn(),
	})),
	resolvePeer: vi.fn(async () => ({
		executablePath: "/consumer/cli.js",
		modulePath: "/consumer/index.js",
	})),
});

const authOptions = (
	fixture: Awaited<ReturnType<typeof makeFixture>>,
	overrides: Partial<AuthOrchestratorOptions> = {},
): AuthOrchestratorOptions => ({
	action: "menu",
	cwd: fixture.projectRoot,
	dataDir: fixture.dataDir,
	environment: {},
	interactive: true,
	packageRoot,
	signal: new AbortController().signal,
	...overrides,
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("auth command orchestration", () => {
	it("lists an empty current-origin registry without loading Playwright", async () => {
		const fixture = await makeFixture();
		const report = vi.fn();
		const prompts = makePrompts();
		const dependencies = defaultAuthDependencies(prompts, report);
		const resolvePeer = vi.fn(dependencies.resolvePeer);

		await orchestrateAuth(
			{
				action: "list",
				cwd: fixture.projectRoot,
				dataDir: fixture.dataDir,
				environment: {},
				interactive: false,
				packageRoot,
				signal: new AbortController().signal,
			},
			{ ...dependencies, resolvePeer },
		);

		expect(report).toHaveBeenCalledWith(
			"No saved profiles for the configured store.",
		);
		expect(prompts.select).not.toHaveBeenCalled();
		expect(resolvePeer).not.toHaveBeenCalled();
	});

	it("captures with explicit role and profile before persisting", async () => {
		const fixture = await makeFixture();
		const report = vi.fn();
		const prompts = makePrompts();
		const dependencies = defaultAuthDependencies(prompts, report);
		const captureProfile = vi.fn(async () => ({
			state: EMPTY_STORAGE_STATE,
			status: "captured" as const,
		}));

		await orchestrateAuth(
			{
				action: "capture",
				cwd: fixture.projectRoot,
				dataDir: fixture.dataDir,
				environment: {},
				interactive: true,
				packageRoot,
				profile: "admin-primary",
				role: "admin",
				signal: new AbortController().signal,
			},
			{
				...dependencies,
				captureProfile,
				loadChromium: vi.fn(async () => ({
					executablePath: vi.fn(() => "/consumer/chromium"),
					launch: vi.fn(),
				})),
				resolvePeer: vi.fn(async () => ({
					executablePath: "/consumer/cli.js",
					modulePath: "/consumer/index.js",
				})),
			},
		);

		expect(captureProfile).toHaveBeenCalledWith(
			expect.objectContaining({ origin: "https://shop.example" }),
		);
		expect(report).toHaveBeenCalledWith(
			expect.stringContaining("run --profile admin-primary"),
		);
		expect(prompts.input).not.toHaveBeenCalled();
	});

	it("rejects non-interactive capture before peer or browser work", async () => {
		const fixture = await makeFixture();
		const prompts = makePrompts();
		const dependencies = defaultAuthDependencies(prompts, vi.fn());
		const resolvePeer = vi.fn(dependencies.resolvePeer);

		await expect(
			orchestrateAuth(
				{
					action: "capture",
					cwd: fixture.projectRoot,
					dataDir: fixture.dataDir,
					environment: {},
					interactive: false,
					packageRoot,
					profile: "admin-primary",
					role: "admin",
					signal: new AbortController().signal,
				},
				{ ...dependencies, resolvePeer },
			),
		).rejects.toThrow(/interactive terminal/i);
		expect(resolvePeer).not.toHaveBeenCalled();
	});

	it("fails missing URL before config, prompts, or peer resolution", async () => {
		const fixture = await makeFixture();
		await rm(join(fixture.projectRoot, ".env"));
		const prompts = makePrompts();
		const dependencies = defaultAuthDependencies(prompts, vi.fn());
		const loadConfig = vi.fn(dependencies.loadConfig);
		const resolvePeer = vi.fn(dependencies.resolvePeer);

		await expect(
			orchestrateAuth(
				{
					action: "menu",
					cwd: fixture.projectRoot,
					dataDir: fixture.dataDir,
					environment: {},
					interactive: true,
					packageRoot,
					signal: new AbortController().signal,
				},
				{ ...dependencies, loadConfig, resolvePeer },
			),
		).rejects.toThrow(/SHOPIFY_STORE_URL.*\.env/i);
		expect(loadConfig).not.toHaveBeenCalled();
		expect(prompts.select).not.toHaveBeenCalled();
		expect(resolvePeer).not.toHaveBeenCalled();
	});

	it("gives .env remediation for every invalid configured URL before prompts or peer resolution", async () => {
		const fixture = await makeFixture();
		const prompts = makePrompts();
		const dependencies = defaultAuthDependencies(prompts, vi.fn());
		const loadConfig = vi.fn(dependencies.loadConfig);
		const resolvePeer = vi.fn(dependencies.resolvePeer);

		await expect(
			orchestrateAuth(
				{
					action: "menu",
					cwd: fixture.projectRoot,
					dataDir: fixture.dataDir,
					environment: {
						SHOPIFY_STORE_URL: "https://user:secret@shop.example",
					},
					interactive: true,
					packageRoot,
					signal: new AbortController().signal,
				},
				{ ...dependencies, loadConfig, resolvePeer },
			),
		).rejects.toThrow(/SHOPIFY_STORE_URL.*\.env/i);
		expect(loadConfig).not.toHaveBeenCalled();
		expect(prompts.select).not.toHaveBeenCalled();
		expect(resolvePeer).not.toHaveBeenCalled();
	});

	it.each([
		{ label: "removes", nextUrl: undefined },
		{ label: "changes", nextUrl: "https://other-shop.example" },
	])("fails closed when trusted config $label SHOPIFY_STORE_URL", async ({
		nextUrl,
	}) => {
		const fixture = await makeFixture();
		const environment: NodeJS.ProcessEnv = {};
		const prompts = makePrompts();
		const dependencies = defaultAuthDependencies(prompts, vi.fn());
		const loadConfig = vi.fn(dependencies.loadConfig);
		loadConfig.mockImplementation(async (options) => {
			const config = await dependencies.loadConfig(options);
			if (nextUrl === undefined) {
				delete environment.SHOPIFY_STORE_URL;
			} else {
				environment.SHOPIFY_STORE_URL = nextUrl;
			}
			return config;
		});
		const resolveDataRoot = vi.fn(dependencies.resolveDataRoot);
		const createStore = vi.fn(dependencies.createStore);
		const resolvePeer = vi.fn(dependencies.resolvePeer);

		await expect(
			orchestrateAuth(
				authOptions(fixture, {
					action: "capture",
					environment,
					profile: "admin-primary",
					role: "admin",
				}),
				{
					...dependencies,
					createStore,
					loadConfig,
					resolveDataRoot,
					resolvePeer,
				},
			),
		).rejects.toThrow(/SHOPIFY_STORE_URL.*\.env/i);
		expect(loadConfig).toHaveBeenCalledTimes(1);
		expect(resolveDataRoot).not.toHaveBeenCalled();
		expect(createStore).not.toHaveBeenCalled();
		expect(prompts.select).not.toHaveBeenCalled();
		expect(resolvePeer).not.toHaveBeenCalled();
	});

	it("bare auth offers exactly capture, refresh, list, and cancel", async () => {
		const fixture = await makeFixture();
		const prompts = makePrompts({ selectValues: ["cancel"] });
		const report = vi.fn();
		const dependencies = defaultAuthDependencies(prompts, report);

		await orchestrateAuth(
			{
				action: "menu",
				cwd: fixture.projectRoot,
				dataDir: fixture.dataDir,
				environment: {},
				interactive: true,
				packageRoot,
				signal: new AbortController().signal,
			},
			dependencies,
		);

		expect(prompts.select).toHaveBeenCalledWith(
			expect.objectContaining({
				choices: expect.arrayContaining([
					expect.objectContaining({ value: "capture" }),
					expect.objectContaining({ value: "refresh" }),
					expect.objectContaining({ value: "list" }),
					expect.objectContaining({ value: "cancel" }),
				]),
			}),
		);
		expect(report).toHaveBeenCalledWith(
			"Authentication menu cancelled; no profile changed.",
		);
	});

	it("disables unavailable menu actions with concise remediation", async () => {
		const fixture = await makeFixture({
			guest: { authentication: "none" },
		});
		const prompts = makePrompts({ selectValues: ["cancel"] });
		const dependencies = defaultAuthDependencies(prompts, vi.fn());
		const resolvePeer = vi.fn(dependencies.resolvePeer);

		await orchestrateAuth(authOptions(fixture), {
			...dependencies,
			resolvePeer,
		});

		const choices = vi.mocked(prompts.select).mock.calls[0]?.[0].choices;
		expect(choices).toEqual([
			expect.objectContaining({
				disabled: "No authenticated role is configured",
				value: "capture",
			}),
			expect.objectContaining({
				disabled: "No runnable saved profile exists",
				value: "refresh",
			}),
			{ name: "List profiles", value: "list" },
			{ name: "Cancel", value: "cancel" },
		]);
		expect(resolvePeer).not.toHaveBeenCalled();
	});

	it("reuses the bare-menu registry summary for list", async () => {
		const fixture = await makeFixture();
		const prompts = makePrompts({ selectValues: ["list"] });
		const report = vi.fn();
		const list = vi.fn(async () => [
			{ name: "admin-primary", role: "admin", status: "runnable" as const },
		]);
		const store = { list } as unknown as ProfileStore;
		const dependencies = defaultAuthDependencies(prompts, report);
		const resolvePeer = vi.fn(dependencies.resolvePeer);

		await orchestrateAuth(authOptions(fixture), {
			...dependencies,
			createStore: vi.fn(() => store),
			resolvePeer,
		});

		expect(list).toHaveBeenCalledTimes(1);
		expect(report).toHaveBeenCalledWith("admin-primary\tadmin\trunnable");
		expect(resolvePeer).not.toHaveBeenCalled();
	});

	it("reuses the bare-menu registry summary and re-resolves only the selected refresh profile", async () => {
		const fixture = await makeFixture();
		const prompts = makePrompts({
			selectValues: ["refresh", "admin-primary"],
		});
		const report = vi.fn();
		const selectedState = stateWithMarker("before");
		const list = vi.fn(async () => [
			{ name: "admin-primary", role: "admin", status: "runnable" as const },
			{ name: "orphaned", role: "removed", status: "invalid" as const },
		]);
		const resolveProfile = vi.fn(async () => ({
			kind: "saved" as const,
			name: "admin-primary",
			role: "admin",
			state: selectedState,
		}));
		const refresh = vi.fn(async () => undefined);
		const store = {
			list,
			refresh,
			resolve: resolveProfile,
		} as unknown as ProfileStore;
		const captureProfile = vi.fn(async () => ({
			state: stateWithMarker("after"),
			status: "captured" as const,
		}));
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, report),
			captureProfile,
		);

		await orchestrateAuth(authOptions(fixture), {
			...dependencies,
			createStore: vi.fn(() => store),
		});

		expect(list).toHaveBeenCalledTimes(1);
		expect(resolveProfile).toHaveBeenCalledTimes(1);
		expect(resolveProfile).toHaveBeenCalledWith("admin-primary");
		expect(captureProfile).toHaveBeenCalledWith(
			expect.objectContaining({ initialState: selectedState }),
		);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(refresh).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "admin-primary",
				signal: expect.any(AbortSignal),
				state: stateWithMarker("after"),
			}),
		);
		const refreshChoices = vi.mocked(prompts.select).mock.calls[1]?.[0].choices;
		expect(refreshChoices).toEqual([
			{ name: "admin-primary - admin", value: "admin-primary" },
		]);
	});

	it.each([
		{ interactive: false, action: "menu" as const },
		{ interactive: false, action: "capture" as const },
		{ interactive: false, action: "refresh" as const },
	])("rejects non-interactive $action without prompting", async (overrides) => {
		const fixture = await makeFixture();
		const prompts = makePrompts();
		const dependencies = defaultAuthDependencies(prompts, vi.fn());
		const resolvePeer = vi.fn(dependencies.resolvePeer);

		await expect(
			orchestrateAuth(authOptions(fixture, overrides), {
				...dependencies,
				resolvePeer,
			}),
		).rejects.toThrow(/interactive terminal/i);
		expect(prompts.select).not.toHaveBeenCalled();
		expect(prompts.input).not.toHaveBeenCalled();
		expect(resolvePeer).not.toHaveBeenCalled();
	});

	it.each([
		{
			label: "both supplied",
			profile: "admin-primary",
			role: "admin",
			selectCalls: 0,
			inputCalls: 0,
		},
		{
			label: "only role supplied",
			profile: undefined,
			role: "admin",
			selectCalls: 0,
			inputCalls: 1,
		},
		{
			label: "only profile supplied",
			profile: "admin-primary",
			role: undefined,
			selectCalls: 1,
			inputCalls: 0,
		},
	])("capture prompts only for missing values when $label", async ({
		inputCalls,
		profile,
		role,
		selectCalls,
	}) => {
		const fixture = await makeFixture();
		const prompts = makePrompts({ selectValues: ["admin"] });
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, vi.fn()),
		);

		await orchestrateAuth(
			authOptions(fixture, {
				action: "capture",
				profile,
				role,
			}),
			dependencies,
		);

		expect(prompts.select).toHaveBeenCalledTimes(selectCalls);
		expect(prompts.input).toHaveBeenCalledTimes(inputCalls);
		expect(dependencies.resolvePeer).toHaveBeenCalledTimes(1);
	});

	it("validates and re-prompts a missing capture profile before resolving Playwright", async () => {
		const fixture = await makeFixture();
		const prompts = makePrompts();
		const input = vi.mocked(prompts.input);
		input.mockImplementationOnce(async (options) => {
			expect(await options.validate?.("Not Valid")).toMatch(/lower-kebab/i);
			expect(await options.validate?.("guest")).toMatch(/collide/i);
			expect(await options.validate?.("admin-primary")).toBe(true);
			return "admin-primary";
		});
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, vi.fn()),
		);

		await orchestrateAuth(
			authOptions(fixture, {
				action: "capture",
				role: "admin",
			}),
			dependencies,
		);

		expect(input).toHaveBeenCalledWith(
			expect.objectContaining({
				message: expect.stringMatching(/lower-kebab.*no credentials/i),
				validate: expect.any(Function),
			}),
		);
		expect(dependencies.resolvePeer).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ profile: "Not Valid", role: "admin" },
		{ profile: "guest", role: "admin" },
		{ profile: "admin-primary", role: "guest" },
		{ profile: "admin-primary", role: "unknown" },
	])("rejects invalid explicit capture selection before Playwright: $profile/$role", async ({
		profile,
		role,
	}) => {
		const fixture = await makeFixture();
		const prompts = makePrompts();
		const dependencies = defaultAuthDependencies(prompts, vi.fn());
		const resolvePeer = vi.fn(dependencies.resolvePeer);

		await expect(
			orchestrateAuth(
				authOptions(fixture, {
					action: "capture",
					profile,
					role,
				}),
				{ ...dependencies, resolvePeer },
			),
		).rejects.toBeInstanceOf(ShopifyE2EPreflightError);
		expect(prompts.select).not.toHaveBeenCalled();
		expect(prompts.input).not.toHaveBeenCalled();
		expect(resolvePeer).not.toHaveBeenCalled();
	});

	it("rejects capture when no authenticated role exists before Playwright", async () => {
		const fixture = await makeFixture({ guest: { authentication: "none" } });
		const prompts = makePrompts();
		const dependencies = defaultAuthDependencies(prompts, vi.fn());
		const resolvePeer = vi.fn(dependencies.resolvePeer);

		await expect(
			orchestrateAuth(authOptions(fixture, { action: "capture" }), {
				...dependencies,
				resolvePeer,
			}),
		).rejects.toThrow(/no role with required authentication/i);
		expect(prompts.select).not.toHaveBeenCalled();
		expect(resolvePeer).not.toHaveBeenCalled();
	});

	it("refresh preserves role and seeds only the selected profile state", async () => {
		const fixture = await makeFixture();
		const before = stateWithMarker("before");
		const after = stateWithMarker("after");
		const store = await seedProfile(fixture, "admin-primary", before);
		const metadataPath = join(
			fixture.dataDir,
			"origins",
			configuredOriginKey("https://shop.example"),
			"profiles",
			"admin-primary",
			"profile.json",
		);
		const metadataBefore = await readFile(metadataPath);
		const prompts = makePrompts();
		const report = vi.fn();
		const captureProfile = vi.fn(async (args) => {
			expect(args.initialState).toEqual(before);
			return { state: after, status: "captured" as const };
		});
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, report),
			captureProfile,
		);
		const list = vi.spyOn(store, "list");

		await orchestrateAuth(
			authOptions(fixture, {
				action: "refresh",
				profile: "admin-primary",
			}),
			{ ...dependencies, createStore: vi.fn(() => store) },
		);

		expect(await store.resolve("admin-primary")).toEqual({
			kind: "saved",
			name: "admin-primary",
			role: "admin",
			state: after,
		});
		expect(await readFile(metadataPath)).toEqual(metadataBefore);
		expect(prompts.select).not.toHaveBeenCalled();
		expect(list).not.toHaveBeenCalled();
		expect(report).toHaveBeenCalledWith(
			"Refreshed profile admin-primary for role admin.",
		);
	});

	it("refresh prompts with runnable saved profiles only", async () => {
		const fixture = await makeFixture();
		await seedProfile(fixture);
		const prompts = makePrompts({ selectValues: ["admin-primary"] });
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, vi.fn()),
		);

		await orchestrateAuth(
			authOptions(fixture, { action: "refresh" }),
			dependencies,
		);

		expect(prompts.select).toHaveBeenCalledWith(
			expect.objectContaining({
				choices: [{ name: "admin-primary - admin", value: "admin-primary" }],
			}),
		);
	});

	it("rejects refresh when there is no runnable saved profile before Playwright", async () => {
		const fixture = await makeFixture();
		const prompts = makePrompts();
		const dependencies = defaultAuthDependencies(prompts, vi.fn());
		const resolvePeer = vi.fn(dependencies.resolvePeer);

		await expect(
			orchestrateAuth(authOptions(fixture, { action: "refresh" }), {
				...dependencies,
				resolvePeer,
			}),
		).rejects.toThrow(/no runnable saved profile/i);
		expect(prompts.select).not.toHaveBeenCalled();
		expect(resolvePeer).not.toHaveBeenCalled();
	});

	it("fails closed when the refresh prompt returns an unavailable profile", async () => {
		const fixture = await makeFixture();
		await seedProfile(fixture);
		const prompts = makePrompts({ selectValues: ["removed-profile"] });
		const dependencies = defaultAuthDependencies(prompts, vi.fn());
		const resolvePeer = vi.fn(dependencies.resolvePeer);

		await expect(
			orchestrateAuth(authOptions(fixture, { action: "refresh" }), {
				...dependencies,
				resolvePeer,
			}),
		).rejects.toThrow(/selected profile is unavailable/i);
		expect(prompts.select).toHaveBeenCalledTimes(1);
		expect(resolvePeer).not.toHaveBeenCalled();
	});

	it.each([
		"unknown",
		"guest",
		"Not Valid",
	])("rejects explicit refresh profile %s before Playwright", async (profile) => {
		const fixture = await makeFixture();
		const prompts = makePrompts();
		const dependencies = defaultAuthDependencies(prompts, vi.fn());
		const resolvePeer = vi.fn(dependencies.resolvePeer);

		await expect(
			orchestrateAuth(authOptions(fixture, { action: "refresh", profile }), {
				...dependencies,
				resolvePeer,
			}),
		).rejects.toBeInstanceOf(ShopifyE2EPreflightError);
		expect(prompts.select).not.toHaveBeenCalled();
		expect(resolvePeer).not.toHaveBeenCalled();
	});

	it.each([
		{ action: "capture" as const, reason: "declined" as const },
		{ action: "capture" as const, reason: "browser-closed" as const },
	])("$reason capture cancellation reports no change and writes nothing", async ({
		action,
		reason,
	}) => {
		const fixture = await makeFixture();
		const prompts = makePrompts();
		const report = vi.fn();
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, report),
			vi.fn(async () => ({ reason, status: "cancelled" as const })),
		);

		await orchestrateAuth(
			authOptions(fixture, {
				action,
				profile: "admin-primary",
				role: "admin",
			}),
			dependencies,
		);

		const store = createProfileStore({
			dataRoot: fixture.dataDir,
			origin: "https://shop.example",
			roles: DEFAULT_ROLES,
		});
		expect(await store.list()).toEqual([]);
		expect(report).toHaveBeenCalledWith(
			"Authentication capture cancelled; no profile changed.",
		);
	});

	it.each([
		"declined",
		"browser-closed",
	] as const)("%s refresh cancellation leaves the prior profile byte-for-byte usable", async (reason) => {
		const fixture = await makeFixture();
		const before = stateWithMarker("before");
		const store = await seedProfile(fixture, "admin-primary", before);
		const metadataPath = join(
			fixture.dataDir,
			"origins",
			configuredOriginKey("https://shop.example"),
			"profiles",
			"admin-primary",
			"profile.json",
		);
		const statePath = join(
			fixture.dataDir,
			"origins",
			configuredOriginKey("https://shop.example"),
			"profiles",
			"admin-primary",
			"storage-state.json",
		);
		const metadataBefore = await readFile(metadataPath);
		const stateBefore = await readFile(statePath);
		const prompts = makePrompts();
		const report = vi.fn();
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, report),
			vi.fn(async () => ({
				reason,
				status: "cancelled" as const,
			})),
		);

		await orchestrateAuth(
			authOptions(fixture, {
				action: "refresh",
				profile: "admin-primary",
			}),
			dependencies,
		);

		expect((await store.resolve("admin-primary")).state).toEqual(before);
		expect(await readFile(metadataPath)).toEqual(metadataBefore);
		expect(await readFile(statePath)).toEqual(stateBefore);
		expect(report).toHaveBeenCalledWith(
			"Authentication refresh cancelled; no profile changed.",
		);
	});

	it("uses an explicit false-by-default terminal confirmation with no credential prompt", async () => {
		const fixture = await makeFixture();
		const prompts = makePrompts({ confirmValue: false });
		const dependencies = withStubbedBrowser(
			defaultAuthDependencies(prompts, vi.fn()),
			vi.fn(async (args) => {
				const confirmed = await args.dependencies.confirmSave({
					signal: args.signal,
				});
				return confirmed
					? { state: EMPTY_STORAGE_STATE, status: "captured" as const }
					: { reason: "declined" as const, status: "cancelled" as const };
			}),
		);

		await orchestrateAuth(
			authOptions(fixture, {
				action: "capture",
				profile: "admin-primary",
				role: "admin",
			}),
			dependencies,
		);

		expect(prompts.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				default: false,
				message: "Authentication complete. Save this browser profile?",
			}),
		);
		const terminalText = JSON.stringify(
			vi.mocked(prompts.confirm).mock.calls[0]?.[0],
		);
		expect(terminalText).not.toMatch(
			/storefront password|shopify password|one-time|credential value/i,
		);
	});

	it("renders only safe list summary fields", async () => {
		const fixture = await makeFixture();
		const prompts = makePrompts();
		const report = vi.fn();
		const list = vi.fn(async () => [
			{ name: "<invalid-name>", role: "unknown", status: "invalid" as const },
			{ name: "admin-primary", role: "admin", status: "runnable" as const },
		]);
		const dependencies = defaultAuthDependencies(prompts, report);
		const resolvePeer = vi.fn(dependencies.resolvePeer);

		await orchestrateAuth(authOptions(fixture, { action: "list" }), {
			...dependencies,
			createStore: vi.fn(() => ({ list }) as unknown as ProfileStore),
			resolvePeer,
		});

		expect(report.mock.calls).toEqual([
			["<invalid-name>\tunknown\tinvalid"],
			["admin-primary\tadmin\trunnable"],
		]);
		expect(JSON.stringify(report.mock.calls)).not.toMatch(
			/cookie|storage-state|\/private|secret/i,
		);
		expect(prompts.select).not.toHaveBeenCalled();
		expect(resolvePeer).not.toHaveBeenCalled();
	});
});

describe("auth command failure mapping", () => {
	it.each([
		"Interrupted profile save could not be rolled back safely",
		"Profile refresh rollback could not complete safely",
	])("preserves rollback failure instead of claiming no change: %s", (message) => {
		expect(
			classifyAuthCommandFailure(
				new ShopifyE2EInfrastructureError(message),
				130,
			),
		).toEqual({ exitCode: 1, message });
	});

	it.each([
		{
			error: new Error("hidden"),
			exitCode: 130,
			expected: 130,
		},
		{
			error: new Error("hidden"),
			exitCode: 143,
			expected: 143,
		},
		{
			error: new CaptureSignalError("SIGINT"),
			exitCode: undefined,
			expected: 130,
		},
		{
			error: new CaptureSignalError("SIGTERM"),
			exitCode: undefined,
			expected: 143,
		},
	])("maps interruption to exit $expected", ({ error, exitCode, expected }) => {
		expect(
			classifyAuthCommandFailure(error, exitCode as 130 | 143 | undefined),
		).toEqual({
			exitCode: expected,
			message: "Authentication interrupted; no profile changed.",
		});
	});

	it.each([
		"ExitPromptError",
		"AbortPromptError",
	])("maps %s without exposing a prompt stack", (name) => {
		const error = new Error("dependency stack and secret");
		error.name = name;
		expect(classifyAuthCommandFailure(error)).toEqual({
			exitCode: 130,
			message: "Authentication interrupted; no profile changed.",
		});
	});

	it("preserves sanitized known errors and hides unknown causes", () => {
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
