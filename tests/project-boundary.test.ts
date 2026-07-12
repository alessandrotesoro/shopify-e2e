import {
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

import { resolveShopifyTestDir } from "../src/config/project-boundary.js";
import { ShopifyE2EPreflightError } from "../src/errors.js";

const temporaryDirectories: string[] = [];

const makeProject = async (): Promise<string> => {
	const project = await mkdtemp(join(tmpdir(), "shopify-e2e-boundary-"));
	temporaryDirectories.push(project);
	return realpath(project);
};

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("Shopify test-directory boundary", () => {
	it("returns the real path of an existing contained directory", async () => {
		const project = await makeProject();
		const testDir = join(project, "tests", "shopify");
		await mkdir(testDir, { recursive: true });

		await expect(
			resolveShopifyTestDir({
				configuredTestDir: "tests/shopify",
				projectRoot: project,
			}),
		).resolves.toBe(testDir);
	});

	it.each([
		{ label: "missing", testDir: "missing" },
		{ label: "the project root", testDir: "." },
	])("rejects a $label test directory", async ({ testDir }) => {
		const project = await makeProject();

		await expect(
			resolveShopifyTestDir({
				configuredTestDir: testDir,
				projectRoot: project,
			}),
		).rejects.toBeInstanceOf(ShopifyE2EPreflightError);
	});

	it("rejects a regular file where a directory is required", async () => {
		const project = await makeProject();
		await writeFile(join(project, "tests"), "not a directory");

		await expect(
			resolveShopifyTestDir({
				configuredTestDir: "tests",
				projectRoot: project,
			}),
		).rejects.toThrow(/directory/i);
	});

	it("rejects lexical traversal and absolute paths outside the project", async () => {
		const project = await makeProject();
		const outside = await makeProject();

		await expect(
			resolveShopifyTestDir({
				configuredTestDir: "../outside",
				projectRoot: project,
			}),
		).rejects.toThrow(/inside.*project/i);
		await expect(
			resolveShopifyTestDir({
				configuredTestDir: outside,
				projectRoot: project,
			}),
		).rejects.toThrow(/inside.*project/i);
	});

	it("rejects a test-root symlink that resolves inside the project", async () => {
		const project = await makeProject();
		const realTests = join(project, "real-tests");
		await mkdir(realTests);
		await symlink(realTests, join(project, "tests"));

		await expect(
			resolveShopifyTestDir({
				configuredTestDir: "tests",
				projectRoot: project,
			}),
		).rejects.toThrow(/symbolic link/i);
	});

	it("rejects a test-root symlink that escapes the project", async () => {
		const project = await makeProject();
		const outside = await makeProject();
		await symlink(outside, join(project, "tests"));

		await expect(
			resolveShopifyTestDir({
				configuredTestDir: "tests",
				projectRoot: project,
			}),
		).rejects.toThrow(/symbolic link|inside.*project/i);
	});
});
