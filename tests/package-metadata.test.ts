import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

describe("package metadata", () => {
	it("configures oclif pattern commands and space-separated topics", async () => {
		const packageJson = JSON.parse(
			await readFile(resolve("package.json"), "utf8"),
		) as {
			bin: Record<string, string>;
			exports: Record<string, unknown>;
			oclif: Record<string, unknown>;
		};

		expect(packageJson.bin["shopify-e2e"]).toBe("./bin/run.js");
		expect(Object.keys(packageJson.exports).sort()).toEqual([
			".",
			"./config",
			"./inputs",
			"./package.json",
			"./playwright",
			"./storefront",
			"./urls",
		]);
		expect(packageJson.oclif.bin).toBe("shopify-e2e");
		expect(packageJson.oclif.commands).toBe("./dist/commands");
		expect(packageJson.oclif.topicSeparator).toBe(" ");
	});

	it("uses oclif execute in the bin entrypoint so command errors are handled", async () => {
		const bin = await readFile(resolve("bin/run.js"), "utf8");

		expect(bin).toContain('import { execute } from "@oclif/core"');
		expect(bin).toContain("await execute({ dir: import.meta.url })");
	});

	it("keeps only command modules in the oclif command discovery tree", async () => {
		await expect(commandFiles(resolve("src/commands"))).resolves.toEqual([
			"auth/restore.ts",
			"auth/save.ts",
			"doctor.ts",
			"open.ts",
			"run.ts",
		]);
	});
});

async function commandFiles(root: string): Promise<string[]> {
	const files = await nestedFiles(root);

	return files
		.map((file) => relative(root, file).split(sep).join("/"))
		.sort();
}

async function nestedFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = await Promise.all(
		entries.map((entry) => {
			const path = join(dir, entry.name);

			return entry.isDirectory() ? nestedFiles(path) : [path];
		}),
	);

	return files.flat();
}
