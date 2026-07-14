import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { vi } from "vitest";

import type {
	AuthOrchestratorDependencies,
	AuthOrchestratorOptions,
	defaultAuthDependencies,
} from "../../src/auth/auth-orchestrator.js";
import type { PlaywrightStorageState } from "../../src/profiles/profile-schema.js";
import {
	createProfileStore,
	EMPTY_STORAGE_STATE,
	type ProfileStore,
} from "../../src/profiles/profile-store.js";
import type { PromptFunctions } from "../../src/prompts/inquirer.js";

export const DEFAULT_ROLES = {
	admin: { authentication: "required" as const },
	guest: { authentication: "none" as const },
};

export interface AuthCommandFixture {
	readonly dataDir: string;
	readonly projectRoot: string;
}

export const createAuthFixtureScope = (): {
	cleanup(): Promise<void>;
	makeFixture(
		roles?: Readonly<
			Record<string, { readonly authentication: "none" | "required" }>
		>,
	): Promise<AuthCommandFixture>;
} => {
	const temporaryDirectories: string[] = [];

	return {
		cleanup: async () => {
			await Promise.all(
				temporaryDirectories
					.splice(0)
					.map((directory) => rm(directory, { force: true, recursive: true })),
			);
		},
		makeFixture: async (roles = DEFAULT_ROLES) => {
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
		},
	};
};

interface MakePromptsOptions {
	readonly confirmValue?: boolean;
	readonly inputValue?: string;
	readonly selectValues?: unknown[];
}

export const makePrompts = ({
	confirmValue = true,
	inputValue = "admin-primary",
	selectValues = [],
}: MakePromptsOptions = {}): PromptFunctions => ({
	confirm: vi.fn(async () => confirmValue),
	input: vi.fn(async () => inputValue),
	select: vi.fn(async () => selectValues.shift()) as PromptFunctions["select"],
});

export const seedProfile = async (
	fixture: AuthCommandFixture,
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

export const withStubbedBrowser = (
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

const packageRoot = resolve(import.meta.dirname, "../..");

export const authOptions = (
	fixture: AuthCommandFixture,
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
