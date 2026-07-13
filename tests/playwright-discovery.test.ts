import { spawnSync } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverShopifySpecs } from "../src/config/discover-specs.js";
import { ShopifyE2EPreflightError } from "../src/errors.js";

const projectRoot = resolve(import.meta.dirname, "..");
const playwrightCli = resolve(
	projectRoot,
	"node_modules/@playwright/test/cli.js",
);
const playwrightTestApi = createRequire(import.meta.url).resolve(
	"@playwright/test",
);
const temporaryDirectories: string[] = [];
const extensions = [
	"js",
	"jsx",
	"ts",
	"tsx",
	"mjs",
	"mjsx",
	"mts",
	"mtsx",
	"cjs",
	"cjsx",
	"cts",
	"ctsx",
] as const;

const makeTestDir = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), "shopify-e2e-discovery-"));
	temporaryDirectories.push(root);
	const physicalRoot = await realpath(root);
	const testDir = join(physicalRoot, "shopify-tests");
	await mkdir(testDir);
	return testDir;
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("Playwright-compatible candidate discovery", () => {
	it("matches every default naming form and extension recursively", async () => {
		const testDir = await makeTestDir();
		const expected: string[] = [];

		for (const [index, extension] of extensions.entries()) {
			const directory = index % 2 === 0 ? testDir : join(testDir, "nested");
			await mkdir(directory, { recursive: true });
			for (const naming of ["spec", "test"] as const) {
				const file = join(directory, `case-${index}.${naming}.${extension}`);
				await writeFile(file, "// candidate\n");
				expected.push(file);
			}
		}

		await expect(discoverShopifySpecs(testDir)).resolves.toEqual(
			expected.sort(),
		);
	});

	it("skips node_modules and .gitignore but does not apply gitignore rules", async () => {
		const testDir = await makeTestDir();
		const included = join(testDir, "ignored-by-rule.spec.ts");
		await mkdir(join(testDir, "node_modules", "dependency"), {
			recursive: true,
		});
		await writeFile(join(testDir, ".gitignore"), "ignored-by-rule.spec.ts\n");
		await writeFile(included, "// candidate\n");
		await writeFile(
			join(testDir, "node_modules", "dependency", "hidden.spec.ts"),
			"// excluded\n",
		);
		await writeFile(join(testDir, "almost.spec.css"), "// excluded\n");
		await writeFile(join(testDir, "spec.ts"), "// excluded\n");

		await expect(discoverShopifySpecs(testDir)).resolves.toEqual([included]);
	});

	it("rejects empty and non-spec-only directories", async () => {
		const empty = await makeTestDir();
		const nonSpec = await makeTestDir();
		await writeFile(join(nonSpec, "helper.ts"), "// not a spec\n");

		await expect(discoverShopifySpecs(empty)).rejects.toBeInstanceOf(
			ShopifyE2EPreflightError,
		);
		await expect(discoverShopifySpecs(nonSpec)).rejects.toThrow(/no runnable/i);
	});

	it.each([
		"file",
		"directory",
	])("rejects a nested %s symlink", async (kind) => {
		const testDir = await makeTestDir();
		const target = join(testDir, kind === "file" ? "target.ts" : "target-dir");
		if (kind === "file") await writeFile(target, "// target\n");
		else await mkdir(target);
		await symlink(target, join(testDir, `linked-${kind}`));

		await expect(discoverShopifySpecs(testDir)).rejects.toThrow(
			/symbolic link/i,
		);
	});

	it("produces the same candidates as Playwright 1.61.1 --list", async () => {
		const testDir = await makeTestDir();
		const root = resolve(testDir, "..");
		await writeFile(join(root, "package.json"), '{"type":"module"}\n');
		const configPath = join(root, "package-generated.playwright.config.mjs");
		const ordinarySentinel = join(root, "ordinary-config-loaded");
		await writeFile(
			join(root, "playwright.config.ts"),
			`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(ordinarySentinel)}, 'loaded');\nexport default {};\n`,
		);
		await writeFile(
			configPath,
			`export default { testDir: ${JSON.stringify(testDir)}, reporter: 'line' };\n`,
		);
		await mkdir(join(testDir, "nested"), { recursive: true });
		await mkdir(join(testDir, "node_modules", "dependency"), {
			recursive: true,
		});
		const candidates = extensions.flatMap((extension, extensionIndex) =>
			(["spec", "test"] as const).map((naming, namingIndex) => {
				const nesting = namingIndex === 0 ? "shallow" : "deeply/nested";
				const candidateName =
					extensionIndex === 0 && naming === "spec"
						? "ignored-by-rule"
						: `candidate-${extensionIndex}`;
				const directory = join(testDir, `level-${extensionIndex % 3}`, nesting);
				return join(directory, `${candidateName}.${naming}.${extension}`);
			}),
		);
		const expectedRelative = candidates
			.map((file) => relative(testDir, file))
			.sort();
		await writeFile(join(testDir, ".gitignore"), `${expectedRelative[0]}\n`);
		for (const [index, file] of candidates.entries()) {
			await mkdir(resolve(file, ".."), { recursive: true });
			await writeFile(
				file,
				`import playwrightTest from ${JSON.stringify(playwrightTestApi)};\nconst { test } = playwrightTest;\ntest('candidate ${index}', () => {});\n`,
			);
		}
		await writeFile(join(testDir, "helper.ts"), "// not a test\n");
		await writeFile(join(testDir, "almost.spec.css"), "// not a test\n");
		await writeFile(join(testDir, "bare-spec.ts"), "// not a test\n");
		await writeFile(join(testDir, "plural.tests.ts"), "// not a test\n");
		await writeFile(join(testDir, "source.spec.ts.map"), "// not a test\n");
		await writeFile(
			join(testDir, "node_modules", "dependency", "hidden.spec.ts"),
			"throw new Error('must not load');\n",
		);

		const discovered = await discoverShopifySpecs(testDir);
		const listed = spawnSync(
			process.execPath,
			[playwrightCli, "test", "--config", configPath, "--list"],
			{ cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
		);

		expect(listed.status, listed.stderr).toBe(0);
		const playwrightFiles = [
			...listed.stdout.matchAll(/^\s*(.+?):\d+:\d+\s+›/gm),
		]
			.map((match) => match[1])
			.filter((file): file is string => file !== undefined)
			.map((file) => relative(testDir, resolve(testDir, file)))
			.sort();
		expect(discovered.map((file) => relative(testDir, file))).toEqual(
			expectedRelative,
		);
		expect(playwrightFiles).toEqual(expectedRelative);
		await expect(access(ordinarySentinel)).rejects.toThrow();
	});
});
