import {
	access,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	loadRunnableShopifyConfig,
	loadShopifyConfig,
} from "../src/config/load-config.js";
import { ShopifyE2EPreflightError } from "../src/errors.js";

const temporaryDirectories: string[] = [];
const rolesSource =
	'roles: { admin: { authentication: "required" }, guest: { authentication: "none" } }';

const makeProject = async (): Promise<string> => {
	const project = await mkdtemp(join(tmpdir(), "shopify-e2e-config-"));
	temporaryDirectories.push(project);
	await mkdir(join(project, "tests"), { recursive: true });
	await writeFile(join(project, "tests", "lane.spec.ts"), "// candidate\n");
	return realpath(project);
};

interface WriteConfigArgs {
	readonly name?: string;
	readonly project: string;
	readonly source: string;
}

const writeConfig = async ({
	name = "shopify-e2e.config.ts",
	project,
	source,
}: WriteConfigArgs): Promise<string> => {
	const configPath = join(project, name);
	await mkdir(resolve(configPath, ".."), { recursive: true });
	await writeFile(configPath, source);
	return configPath;
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("dedicated Shopify configuration", () => {
	it("loads the exact conventional config and resolves testDir from cwd", async () => {
		const project = await makeProject();
		await writeConfig({
			project,
			source: `export default { testDir: 'tests', ${rolesSource} };\n`,
		});

		await expect(loadShopifyConfig({ projectRoot: project })).resolves.toEqual({
			configPath: join(project, "shopify-e2e.config.ts"),
			projectRoot: project,
			roles: {
				admin: { authentication: "required" },
				guest: { authentication: "none" },
			},
			testDir: join(project, "tests"),
		});
	});

	it("loads a contained explicit config but still resolves testDir from cwd", async () => {
		const project = await makeProject();
		await writeConfig({
			name: "configs/alternate.ts",
			project,
			source: `export default { ${rolesSource}, testDir: 'tests' };\n`,
		});

		const result = await loadShopifyConfig({
			configPath: "configs/alternate.ts",
			projectRoot: project,
		});

		expect(result.configPath).toBe(join(project, "configs", "alternate.ts"));
		expect(result.testDir).toBe(join(project, "tests"));
	});

	it("loads roles for auth without specs but requires a spec for run", async () => {
		const project = await makeProject();
		await rm(join(project, "tests", "lane.spec.ts"));
		await writeConfig({
			project,
			source: `export default { testDir: 'tests', ${rolesSource} };\n`,
		});

		await expect(loadShopifyConfig({ projectRoot: project })).resolves.toEqual(
			expect.objectContaining({
				roles: {
					admin: { authentication: "required" },
					guest: { authentication: "none" },
				},
				testDir: join(project, "tests"),
			}),
		);
		await expect(
			loadRunnableShopifyConfig({ projectRoot: project }),
		).rejects.toThrow(/no runnable Playwright specs/i);

		await writeFile(join(project, "tests", "lane.spec.ts"), "// candidate\n");
		await expect(
			loadRunnableShopifyConfig({ projectRoot: project }),
		).resolves.toEqual(
			expect.objectContaining({ testDir: join(project, "tests") }),
		);
	});

	it("does not discover or import the ordinary Playwright config", async () => {
		const project = await makeProject();
		const sentinel = join(project, "ordinary-loaded");
		await writeConfig({
			project,
			source: `export default { testDir: 'tests', ${rolesSource} };\n`,
		});
		await writeFile(
			join(project, "playwright.config.ts"),
			`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'loaded');\nexport default {};\n`,
		);

		await loadShopifyConfig({ projectRoot: project });

		await expect(access(sentinel)).rejects.toThrow();
	});

	it("does not leave a transformed consumer config in jiti's filesystem cache", async () => {
		const project = await makeProject();
		const temporaryRoot = join(project, "temporary-root");
		await mkdir(temporaryRoot);
		await writeConfig({
			project,
			source: `export default { testDir: 'tests', ${rolesSource} };\n`,
		});
		vi.stubEnv("TEMP", temporaryRoot);
		vi.stubEnv("TMP", temporaryRoot);
		vi.stubEnv("TMPDIR", temporaryRoot);

		try {
			await loadShopifyConfig({ projectRoot: project });
		} finally {
			vi.unstubAllEnvs();
		}

		await expect(access(join(temporaryRoot, "jiti"))).rejects.toThrow();
	});

	it.each([
		{
			label: "a missing default export",
			source: "export const testDir = 'tests';\n",
		},
		{ label: "a non-object export", source: "export default 'tests';\n" },
		{ label: "an array export", source: "export default ['tests'];\n" },
		{
			label: "an empty testDir",
			source: `export default { testDir: '  ', ${rolesSource} };\n`,
		},
		{
			label: "a wrong testDir type",
			source: `export default { testDir: 42, ${rolesSource} };\n`,
		},
		{
			label: "an unknown key",
			source: `export default { testDir: 'tests', ${rolesSource}, workers: 2 };\n`,
		},
		{
			label: "a missing roles map",
			source: "export default { testDir: 'tests' };\n",
		},
		{
			label: "an empty roles map",
			source: "export default { testDir: 'tests', roles: {} };\n",
		},
		{
			label: "an invalid role name",
			source:
				'export default { testDir: "tests", roles: { "Admin User": { authentication: "required" } } };\n',
		},
		{
			label: "an invalid authentication mode",
			source:
				'export default { testDir: "tests", roles: { admin: { authentication: "optional" } } };\n',
		},
		{
			label: "an extra role key",
			source:
				'export default { testDir: "tests", roles: { admin: { authentication: "required", label: "Admin" } } };\n',
		},
		{
			label: "a roles array",
			source:
				'export default { testDir: "tests", roles: [{ authentication: "required" }] };\n',
		},
		{
			label: "a config accessor",
			source:
				'const config = { roles: { admin: { authentication: "required" } } }; Object.defineProperty(config, "testDir", { enumerable: true, get() { throw new Error("accessor secret"); } }); export default config;\n',
		},
		{
			label: "a role-map accessor",
			source:
				'const roles = {}; Object.defineProperty(roles, "admin", { enumerable: true, get() { throw new Error("accessor secret"); } }); export default { testDir: "tests", roles };\n',
		},
		{
			label: "an authentication accessor",
			source:
				'const admin = {}; Object.defineProperty(admin, "authentication", { enumerable: true, get() { throw new Error("accessor secret"); } }); export default { testDir: "tests", roles: { admin } };\n',
		},
		{
			label: "a symbol config key",
			source:
				'export default { testDir: "tests", roles: { admin: { authentication: "required" } }, [Symbol("hidden")]: true };\n',
		},
		{
			label: "a symbol role key",
			source:
				'export default { testDir: "tests", roles: { admin: { authentication: "required" }, [Symbol("hidden")]: { authentication: "none" } } };\n',
		},
		{
			label: "a custom config prototype",
			source:
				'export default Object.assign(Object.create({ hidden: true }), { testDir: "tests", roles: { admin: { authentication: "required" } } });\n',
		},
		{
			label: "a custom roles prototype",
			source:
				'const roles = Object.assign(Object.create({ hidden: true }), { admin: { authentication: "required" } }); export default { testDir: "tests", roles };\n',
		},
		{
			label: "a custom role-record prototype",
			source:
				'const admin = Object.assign(Object.create({ hidden: true }), { authentication: "required" }); export default { testDir: "tests", roles: { admin } };\n',
		},
	])("rejects $label with selected-file context", async ({ source }) => {
		const project = await makeProject();
		const configPath = await writeConfig({ project, source });

		const promise = loadShopifyConfig({ projectRoot: project });

		await expect(promise).rejects.toBeInstanceOf(ShopifyE2EPreflightError);
		await expect(promise).rejects.toThrow(configPath);
		await expect(promise).rejects.not.toThrow(/accessor secret/i);
	});

	it("rejects a phase-one config with migration guidance and exit 2", async () => {
		const project = await makeProject();
		await writeConfig({
			project,
			source: "export default { testDir: 'tests' };\n",
		});

		const error = await loadShopifyConfig({ projectRoot: project }).catch(
			(cause: unknown) => cause,
		);

		expect(error).toBeInstanceOf(ShopifyE2EPreflightError);
		expect(error).toMatchObject({ exitCode: 2 });
		expect(error).toHaveProperty(
			"message",
			expect.stringMatching(
				/add an explicit roles map.*migrating from 0\.1\.x/i,
			),
		);
	});

	it("wraps evaluation failures with selected-file context", async () => {
		const project = await makeProject();
		const configPath = await writeConfig({
			project,
			source: `throw new Error('consumer secret');\nexport default { testDir: 'tests', ${rolesSource} };\n`,
		});

		const promise = loadShopifyConfig({ projectRoot: project });

		await expect(promise).rejects.toBeInstanceOf(ShopifyE2EPreflightError);
		await expect(promise).rejects.toThrow(configPath);
		await expect(promise).rejects.toThrow(/could not load/i);
		await expect(promise).rejects.not.toThrow(/consumer secret/i);
	});

	it.each([
		{ configPath: undefined, label: "a missing conventional config" },
		{ configPath: "alternate.js", label: "an unsupported extension" },
		{ configPath: "missing.ts", label: "a missing explicit config" },
	])("rejects $label", async ({ configPath }) => {
		const project = await makeProject();

		await expect(
			loadShopifyConfig({ configPath, projectRoot: project }),
		).rejects.toBeInstanceOf(ShopifyE2EPreflightError);
	});

	it("rejects explicit configs outside the project", async () => {
		const project = await makeProject();
		const outside = await makeProject();
		const outsideConfig = await writeConfig({
			project: outside,
			source: `export default { testDir: 'tests', ${rolesSource} };\n`,
		});

		await expect(
			loadShopifyConfig({ configPath: outsideConfig, projectRoot: project }),
		).rejects.toThrow(/inside.*project/i);
	});

	it("rejects a symlinked config before evaluation", async () => {
		const project = await makeProject();
		const target = await writeConfig({
			name: "target.ts",
			project,
			source: "export default { testDir: 'tests' };\n",
		});
		await symlink(target, join(project, "shopify-e2e.config.ts"));

		await expect(loadShopifyConfig({ projectRoot: project })).rejects.toThrow(
			/symbolic link/i,
		);
	});
});
