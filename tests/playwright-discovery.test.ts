import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverShopifySpecs } from "../src/config/discover-specs.js";
import { ShopifyE2EPreflightError } from "../src/errors.js";

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

describe("Shopify test-directory plausibility discovery", () => {
	it("accepts every Playwright-loadable JavaScript and TypeScript extension regardless of filename", async () => {
		const testDir = await makeTestDir();
		const expected: string[] = [];

		for (const [index, extension] of extensions.entries()) {
			const directory = index % 2 === 0 ? testDir : join(testDir, "nested");
			await mkdir(directory, { recursive: true });
			const file = join(directory, `arbitrary-name-${index}.${extension}`);
			await writeFile(file, "// plausible source file\n");
			expected.push(file);
		}

		await expect(discoverShopifySpecs(testDir)).resolves.toEqual(
			expected.sort(),
		);
	});

	it("excludes node_modules but ignores matcher and git-ignore semantics", async () => {
		const testDir = await makeTestDir();
		const ignoredByRule = join(testDir, "ignored-by-rule.ts");
		const customMatcherMiss = join(testDir, "not-a-default-spec.mjsx");
		await mkdir(join(testDir, "node_modules", "dependency"), {
			recursive: true,
		});
		await writeFile(
			join(testDir, ".gitignore"),
			"ignored-by-rule.ts\n*.mjsx\n",
		);
		await writeFile(ignoredByRule, "// still plausible\n");
		await writeFile(customMatcherMiss, "// still plausible\n");
		await writeFile(
			join(testDir, "node_modules", "dependency", "hidden.ts"),
			"// excluded subtree\n",
		);
		await writeFile(join(testDir, "almost.ts.map"), "// excluded\n");

		await expect(discoverShopifySpecs(testDir)).resolves.toEqual(
			[ignoredByRule, customMatcherMiss].sort(),
		);
	});

	it("rejects empty and non-JavaScript-or-TypeScript-only directories", async () => {
		const empty = await makeTestDir();
		const nonSource = await makeTestDir();
		await writeFile(join(nonSource, "README.md"), "not source\n");
		await writeFile(join(nonSource, "styles.css"), "/* not source */\n");

		await expect(discoverShopifySpecs(empty)).rejects.toBeInstanceOf(
			ShopifyE2EPreflightError,
		);
		await expect(discoverShopifySpecs(nonSource)).rejects.toThrow(
			/no JavaScript or TypeScript files/i,
		);
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

	it.skipIf(
		process.platform === "win32" ||
			(typeof process.getuid === "function" && process.getuid() === 0),
	)("rejects an unreadable nested directory", async () => {
		const testDir = await makeTestDir();
		const unreadable = join(testDir, "unreadable");
		await mkdir(unreadable);
		await chmod(unreadable, 0o000);

		try {
			await expect(discoverShopifySpecs(testDir)).rejects.toThrow(
				/Could not inspect Shopify test directory/i,
			);
		} finally {
			await chmod(unreadable, 0o700);
		}
	});

	it("never imports plausible source files", async () => {
		const testDir = await makeTestDir();
		const marker = join(testDir, "candidate-imported.marker");
		const candidate = join(testDir, "custom-candidate.cts");
		await writeFile(
			candidate,
			`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "imported");\n`,
		);

		await expect(discoverShopifySpecs(testDir)).resolves.toEqual([candidate]);
		await expect(access(marker)).rejects.toThrow();
	});
});
