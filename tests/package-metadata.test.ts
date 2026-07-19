import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");

const readPackage = async (): Promise<Record<string, unknown>> => {
	const contents = await readFile(resolve(projectRoot, "package.json"), "utf8");
	return JSON.parse(contents) as Record<string, unknown>;
};

const readPackageLock = async (): Promise<{
	readonly packages: Record<
		string,
		{
			readonly dependencies?: Record<string, string>;
			readonly engines?: Record<string, string>;
			readonly version?: string;
		}
	>;
	readonly version: string;
}> => {
	const contents = await readFile(
		resolve(projectRoot, "package-lock.json"),
		"utf8",
	);
	return JSON.parse(contents) as Awaited<ReturnType<typeof readPackageLock>>;
};

describe("package metadata", () => {
	it("publishes the intended CLI-only package shell", async () => {
		const packageJson = await readPackage();

		expect(packageJson.name).toBe("@sematico/shopify-e2e");
		expect(packageJson.version).toBe("0.6.0");
		expect(packageJson.engines).toEqual({ node: ">=20" });
		expect(packageJson.type).toBe("module");
		expect(packageJson.bin).toEqual({ "shopify-e2e": "./bin/run.js" });
		expect(packageJson.files).toEqual(["bin", "dist", "LICENSE"]);
		expect(packageJson.exports).toEqual({
			"./config": {
				default: "./dist/config/public.cjs",
				import: "./dist/config/public.cjs",
				require: "./dist/config/public.cjs",
				types: "./dist/config/public.d.cts",
			},
		});
	});

	it("pins the shell dependencies and declares the supported Playwright peer", async () => {
		const packageJson = await readPackage();

		expect(packageJson.dependencies).toEqual({
			"@inquirer/prompts": "7.10.1",
			"@oclif/core": "4.11.14",
			dotenv: "17.4.2",
			jiti: "2.7.0",
			semver: "^7.7.4",
		});
		expect(packageJson.devDependencies).toMatchObject({
			"@playwright/test": "1.61.1",
			vite: "6.4.3",
			vitest: "3.2.7",
		});
		expect(packageJson.peerDependencies).toEqual({
			"@playwright/test": ">=1.61.1 <1.62.0",
		});
		expect(packageJson.peerDependenciesMeta).toEqual({
			"@playwright/test": { optional: true },
		});
	});

	it("pins the package-owned Jiti implementation exactly", async () => {
		const lockfile = await readPackageLock();

		expect(lockfile.packages[""]?.dependencies?.jiti).toBe("2.7.0");
		expect(lockfile.packages["node_modules/jiti"]?.version).toBe("2.7.0");
	});

	it("coordinates the 0.6.0 release and prompt pin in the lockfile", async () => {
		const lockfile = await readPackageLock();

		expect(lockfile.version).toBe("0.6.0");
		expect(lockfile.packages[""]).toMatchObject({
			dependencies: { "@inquirer/prompts": "7.10.1" },
			engines: { node: ">=20" },
			version: "0.6.0",
		});
		expect(lockfile.packages["node_modules/@inquirer/prompts"]?.version).toBe(
			"7.10.1",
		);
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

	it("keeps browser execution outside deterministic verification", async () => {
		const packageJson = await readPackage();

		expect(packageJson.scripts).toMatchObject({
			"test:browser:roles":
				"npm run build && vitest run tests/browser-role-isolation.test.ts",
			"test:fast":
				"vitest run --exclude tests/installed-cli.test.ts --exclude tests/installed-doctor-cli.test.ts --exclude tests/browser-role-isolation.test.ts",
			"test:installed:built":
				"vitest run tests/installed-cli.test.ts tests/installed-doctor-cli.test.ts",
			verify:
				"npm run lint && npm run typecheck && npm run build && npm run test:fast && npm run test:installed:built",
		});
	});

	it("exports only the explicit phase-three command surface from source and generated maps", async () => {
		const sourceMap = await import(
			`${pathToFileURL(resolve(projectRoot, "src/commands.ts")).href}?source-map`
		);
		const generatedMap = await import(
			`${pathToFileURL(resolve(projectRoot, "dist/commands.js")).href}?generated-map`
		);

		const expectedCommands = [
			"auth",
			"auth:capture",
			"auth:list",
			"auth:refresh",
			"auth:remove",
			"doctor",
			"run",
		];
		expect(Object.keys(sourceMap.default)).toEqual(expectedCommands);
		expect(Object.keys(generatedMap.default)).toEqual(expectedCommands);
	});
});
