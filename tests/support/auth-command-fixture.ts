import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { vi } from "vitest";

import type {
	AuthOrchestratorDependencies,
	AuthOrchestratorOptions,
	defaultAuthDependencies,
} from "../../src/auth/auth-orchestrator.js";
import type { PromptFunctions } from "../../src/prompts/inquirer.js";
import {
	createRoleStateStore,
	type RoleStateStore,
} from "../../src/role-states/role-state-store.js";
import type { PlaywrightStorageState } from "../../src/storage-state/schema.js";

export const DEFAULT_ROLES = ["admin", "customer"] as const;
export const EMPTY_STORAGE_STATE: PlaywrightStorageState = {
	cookies: [],
	origins: [],
};

export interface AuthCommandFixture {
	readonly dataDir: string;
	readonly projectRoot: string;
}

const configHelperPath = resolve(
	import.meta.dirname,
	"../../src/config/public.ts",
);

export const createAuthFixtureScope = (): {
	cleanup(): Promise<void>;
	makeFixture(roles?: readonly string[]): Promise<AuthCommandFixture>;
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
				`import { defineShopifyE2EConfig } from ${JSON.stringify(configHelperPath)};\nexport default defineShopifyE2EConfig(${JSON.stringify({ roles, testDir: "shopify-tests" })});\n`,
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
	readonly selectValues?: unknown[];
}

export const makePrompts = ({
	confirmValue = true,
	selectValues = [],
}: MakePromptsOptions = {}): PromptFunctions => ({
	checkbox: vi.fn(async () =>
		selectValues.shift(),
	) as PromptFunctions["checkbox"],
	confirm: vi.fn(async () => confirmValue),
	select: vi.fn(async () => selectValues.shift()) as PromptFunctions["select"],
});

export const seedRoleState = async (
	fixture: AuthCommandFixture,
	role = "admin",
	state: PlaywrightStorageState = EMPTY_STORAGE_STATE,
	roles: readonly string[] = DEFAULT_ROLES,
): Promise<RoleStateStore> => {
	const store = createRoleStateStore({
		dataRoot: fixture.dataDir,
		origin: "https://shop.example",
		roles,
	});
	await store.capture({ role, state });
	return store;
};

export const withStubbedBrowser = (
	dependencies: ReturnType<typeof defaultAuthDependencies>,
	captureRoleState: AuthOrchestratorDependencies["captureRoleState"] = vi.fn(
		async () => ({
			state: EMPTY_STORAGE_STATE,
			status: "captured" as const,
		}),
	),
) => ({
	...dependencies,
	captureRoleState,
	loadChromium: vi.fn(async () => ({
		executablePath: vi.fn(() => "/consumer/chromium"),
		launch: vi.fn(),
		launchServer: vi.fn(),
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
