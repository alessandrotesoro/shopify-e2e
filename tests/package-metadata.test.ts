import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");

async function readPackage(): Promise<Record<string, unknown>> {
	const contents = await readFile(resolve(projectRoot, "package.json"), "utf8");
	return JSON.parse(contents) as Record<string, unknown>;
}

describe("package metadata", () => {
	it("publishes the intended CLI-only package shell", async () => {
		const packageJson = await readPackage();

		expect(packageJson.name).toBe("@sematico/shopify-e2e");
		expect(packageJson.type).toBe("module");
		expect(packageJson.bin).toEqual({ "shopify-e2e": "./bin/run.js" });
		expect(packageJson.files).toEqual(["bin", "dist", "LICENSE"]);
		expect(packageJson.exports).toEqual({});
	});

	it("pins the shell dependencies and declares the supported Playwright peer", async () => {
		const packageJson = await readPackage();

		expect(packageJson.dependencies).toMatchObject({
			"@oclif/core": "4.11.14",
			jiti: "^2.6.1",
			semver: "^7.7.4",
		});
		expect(packageJson.devDependencies).toMatchObject({
			"@playwright/test": "1.61.1",
		});
		expect(packageJson.peerDependencies).toEqual({
			"@playwright/test": ">=1.61.1 <1.62.0",
		});
		expect(packageJson.peerDependenciesMeta).toEqual({
			"@playwright/test": { optional: true },
		});
	});

	it("uses clean builds and explicit space-separated oclif discovery", async () => {
		const packageJson = await readPackage();

		expect(packageJson.scripts).toMatchObject({
			build: "npm run clean && tsc -p tsconfig.json",
			clean:
				"node -e \"require('node:fs').rmSync('dist',{recursive:true,force:true})\"",
		});
		expect(packageJson.oclif).toMatchObject({
			bin: "shopify-e2e",
			commands: {
				strategy: "explicit",
				target: "./dist/commands.js",
			},
			topicSeparator: " ",
		});
	});

	it("exports only the run command from source and generated maps", async () => {
		const sourceMap = await import(
			`${pathToFileURL(resolve(projectRoot, "src/commands.ts")).href}?source-map`
		);
		const generatedMap = await import(
			`${pathToFileURL(resolve(projectRoot, "dist/commands.js")).href}?generated-map`
		);

		expect(Object.keys(sourceMap.default)).toEqual(["run"]);
		expect(Object.keys(generatedMap.default)).toEqual(["run"]);
	});
});
