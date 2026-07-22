import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	cleanupInstalledCliFixture,
	makeTemporaryDirectory,
	packVerifiedPackage,
} from "./support/installed-cli-harness.js";
import { installPackedPackage } from "./support/installed-consumer.js";

const projectRoot = resolve(import.meta.dirname, "..");
const expectedRuntimeExports = [
	"shopifyFixtures",
	"typeLikeHuman",
	"unlockStorefront",
];

const runNode = (
	consumerRoot: string,
	args: readonly string[],
): ReturnType<typeof spawnSync> =>
	spawnSync(process.execPath, args, {
		cwd: consumerRoot,
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
		timeout: 30_000,
	});

const expectSuccess = (
	result: ReturnType<typeof spawnSync>,
	label: string,
): void => {
	expect(
		result.status,
		`${label} failed\n${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
	).toBe(0);
};

describe.sequential("installed Playwright fixture release boundary", () => {
	let consumerRoot = "";
	let installedPackageRoot = "";

	beforeAll(async () => {
		const tarballPath = await packVerifiedPackage(projectRoot);
		consumerRoot = await makeTemporaryDirectory(
			"shopify-e2e-installed-playwright-fixtures-",
		);
		await writeFile(
			join(consumerRoot, "package.json"),
			'{"name":"installed-playwright-fixture-consumer","private":true,"type":"module"}\n',
		);
		await installPackedPackage({
			consumerRoot,
			hasPlaywright: true,
			tarballPath,
		});
		installedPackageRoot = join(
			consumerRoot,
			"node_modules",
			"@sematico",
			"shopify-e2e",
		);
	}, 240_000);

	afterAll(cleanupInstalledCliFixture);

	it("imports the exact runtime API through ESM and CommonJS", () => {
		const esm = runNode(consumerRoot, [
			"--input-type=module",
			"--eval",
			`const api = await import("@sematico/shopify-e2e/playwright");
const keys = Object.keys(api).filter(key => !["__esModule", "default", "module.exports"].includes(key)).sort();
const defaultKeys = Object.keys(api.default ?? {}).sort();
console.log(JSON.stringify({ keys, defaultKeys }));`,
		]);
		expectSuccess(esm, "ESM fixture import");
		expect(JSON.parse(String(esm.stdout).trim())).toEqual({
			defaultKeys: expectedRuntimeExports,
			keys: expectedRuntimeExports,
		});

		const commonJs = runNode(consumerRoot, [
			"--input-type=commonjs",
			"--eval",
			'console.log(JSON.stringify(Object.keys(require("@sematico/shopify-e2e/playwright")).sort()));',
		]);
		expectSuccess(commonJs, "CommonJS fixture require");
		expect(JSON.parse(String(commonJs.stdout).trim())).toEqual(
			expectedRuntimeExports,
		);
	});

	it("typechecks base and already-extended consumer composition", async () => {
		const peerPackage = JSON.parse(
			await readFile(
				join(
					consumerRoot,
					"node_modules",
					"@playwright",
					"test",
					"package.json",
				),
				"utf8",
			),
		) as { readonly version: string };
		expect(peerPackage.version).toBe("1.61.1");

		await writeFile(
			join(consumerRoot, "fixture-consumer.ts"),
			`import { test as base } from "@playwright/test";
import { shopifyFixtures, type ShopifyFixtures } from "@sematico/shopify-e2e/playwright";

const direct = base.extend<ShopifyFixtures>(shopifyFixtures);
const ordinary = base.extend<{ consumerValue: string }>({
  consumerValue: async (_fixtures, use) => use("consumer"),
});
const composed = ordinary.extend<ShopifyFixtures>(shopifyFixtures);

direct("direct", async ({ storefront }) => {
  await storefront.open();
  await storefront.unlock();
});
composed("composed", async ({ consumerValue, storefront }) => {
  consumerValue.toUpperCase();
  await storefront.open();
  await storefront.unlock();
});
`,
		);
		await writeFile(
			join(consumerRoot, "tsconfig.json"),
			`${JSON.stringify(
				{
					compilerOptions: {
						lib: ["ES2022", "DOM", "ESNext.Disposable"],
						module: "NodeNext",
						moduleResolution: "NodeNext",
						noEmit: true,
						strict: true,
						target: "ES2022",
						typeRoots: [resolve(projectRoot, "node_modules", "@types")],
						types: ["node"],
					},
					files: ["fixture-consumer.ts"],
				},
				null,
				2,
			)}\n`,
		);

		const typecheck = runNode(consumerRoot, [
			resolve(projectRoot, "node_modules", "typescript", "bin", "tsc"),
			"--project",
			"tsconfig.json",
		]);
		expectSuccess(typecheck, "installed fixture consumer typecheck");
	});

	it("ships a peer-free runtime closure without private Playwright internals", async () => {
		const closurePaths = [
			"dist/playwright/public.cjs",
			"dist/playwright/fixtures.cjs",
			"dist/playwright/storefront.cjs",
			"dist/playwright/type-like-human.cjs",
			"dist/role-states/configured-origin.cjs",
		];
		const closure = await Promise.all(
			closurePaths.map(async (path) => ({
				contents: await readFile(join(installedPackageRoot, path), "utf8"),
				path,
			})),
		);

		for (const file of closure) {
			expect(file.contents, file.path).not.toMatch(
				/@playwright\/test|playwright-core|playwright\/lib|(?:require\(|from\s+)["'][^"']*(?:invocation|peer|browser-server|serial-role-runner|execution-context)/,
			);
		}
	});
});
