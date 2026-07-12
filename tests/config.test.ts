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

import { loadShopifyConfig } from "../src/config/load-config.js";
import { ShopifyE2EPreflightError } from "../src/errors.js";

const temporaryDirectories: string[] = [];

async function makeProject(): Promise<string> {
	const project = await mkdtemp(join(tmpdir(), "shopify-e2e-config-"));
	temporaryDirectories.push(project);
	await mkdir(join(project, "tests"), { recursive: true });
	await writeFile(join(project, "tests", "lane.spec.ts"), "// candidate\n");
	return realpath(project);
}

async function writeConfig(
	project: string,
	source: string,
	name = "shopify-e2e.config.ts",
): Promise<string> {
	const configPath = join(project, name);
	await mkdir(resolve(configPath, ".."), { recursive: true });
	await writeFile(configPath, source);
	return configPath;
}

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
		await writeConfig(project, "export default { testDir: 'tests' };\n");

		await expect(loadShopifyConfig({ cwd: project })).resolves.toEqual({
			configPath: join(project, "shopify-e2e.config.ts"),
			projectRoot: project,
			testDir: join(project, "tests"),
		});
	});

	it("loads a contained explicit config but still resolves testDir from cwd", async () => {
		const project = await makeProject();
		await writeConfig(
			project,
			"export default { testDir: 'tests' };\n",
			"configs/alternate.ts",
		);

		const result = await loadShopifyConfig({
			configPath: "configs/alternate.ts",
			cwd: project,
		});

		expect(result.configPath).toBe(join(project, "configs", "alternate.ts"));
		expect(result.testDir).toBe(join(project, "tests"));
	});

	it("does not discover or import the ordinary Playwright config", async () => {
		const project = await makeProject();
		const sentinel = join(project, "ordinary-loaded");
		await writeConfig(project, "export default { testDir: 'tests' };\n");
		await writeFile(
			join(project, "playwright.config.ts"),
			`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'loaded');\nexport default {};\n`,
		);

		await loadShopifyConfig({ cwd: project });

		await expect(
			import("node:fs/promises").then(({ stat }) => stat(sentinel)),
		).rejects.toThrow();
	});

	it("does not leave a transformed consumer config in jiti's filesystem cache", async () => {
		const project = await makeProject();
		const temporaryRoot = join(project, "temporary-root");
		await mkdir(temporaryRoot);
		await writeConfig(project, "export default { testDir: 'tests' };\n");
		vi.stubEnv("TEMP", temporaryRoot);
		vi.stubEnv("TMP", temporaryRoot);
		vi.stubEnv("TMPDIR", temporaryRoot);

		try {
			await loadShopifyConfig({ cwd: project });
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
			source: "export default { testDir: '  ' };\n",
		},
		{
			label: "a wrong testDir type",
			source: "export default { testDir: 42 };\n",
		},
		{
			label: "an unknown key",
			source: "export default { testDir: 'tests', workers: 2 };\n",
		},
	])("rejects $label with selected-file context", async ({ source }) => {
		const project = await makeProject();
		const configPath = await writeConfig(project, source);

		const promise = loadShopifyConfig({ cwd: project });

		await expect(promise).rejects.toBeInstanceOf(ShopifyE2EPreflightError);
		await expect(promise).rejects.toThrow(configPath);
	});

	it("wraps evaluation failures with selected-file context", async () => {
		const project = await makeProject();
		const configPath = await writeConfig(
			project,
			"throw new Error('consumer secret');\nexport default { testDir: 'tests' };\n",
		);

		const promise = loadShopifyConfig({ cwd: project });

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
			loadShopifyConfig({ configPath, cwd: project }),
		).rejects.toBeInstanceOf(ShopifyE2EPreflightError);
	});

	it("rejects explicit configs outside the project", async () => {
		const project = await makeProject();
		const outside = await makeProject();
		const outsideConfig = await writeConfig(
			outside,
			"export default { testDir: 'tests' };\n",
		);

		await expect(
			loadShopifyConfig({ configPath: outsideConfig, cwd: project }),
		).rejects.toThrow(/inside.*project/i);
	});

	it("rejects a symlinked config before evaluation", async () => {
		const project = await makeProject();
		const target = await writeConfig(
			project,
			"export default { testDir: 'tests' };\n",
			"target.ts",
		);
		await symlink(target, join(project, "shopify-e2e.config.ts"));

		await expect(loadShopifyConfig({ cwd: project })).rejects.toThrow(
			/symbolic link/i,
		);
	});
});
