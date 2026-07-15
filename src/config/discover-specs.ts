import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";

import { ShopifyE2EPreflightError } from "../errors.js";

// Doctor proves only source-file plausibility. Playwright owns matcher and
// git-ignore semantics during an actual run.
const playwrightLoadableSourceExtensions = new Set([
	".js",
	".jsx",
	".ts",
	".tsx",
	".mjs",
	".mjsx",
	".mts",
	".mtsx",
	".cjs",
	".cjsx",
	".cts",
	".ctsx",
]);

export const discoverShopifySpecs = async (
	testDir: string,
): Promise<readonly string[]> => {
	const candidates: string[] = [];

	const visit = async (directory: string): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true }).catch(
			(cause: unknown) => {
				throw new ShopifyE2EPreflightError(
					`Could not inspect Shopify test directory: ${directory}`,
					{ cause },
				);
			},
		);
		entries.sort((left, right) => left.name.localeCompare(right.name));

		for (const entry of entries) {
			const entryPath = join(directory, entry.name);
			if (entry.isSymbolicLink()) {
				throw new ShopifyE2EPreflightError(
					`Shopify test directory must not contain a symbolic link: ${entryPath}`,
				);
			}
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules") await visit(entryPath);
				continue;
			}
			if (
				entry.isFile() &&
				playwrightLoadableSourceExtensions.has(extname(entry.name))
			) {
				candidates.push(entryPath);
			}
		}
	};

	await visit(testDir);
	candidates.sort((left, right) => left.localeCompare(right));
	if (candidates.length === 0) {
		throw new ShopifyE2EPreflightError(
			`Shopify test directory contains no JavaScript or TypeScript files with a Playwright-loadable extension: ${testDir}`,
		);
	}
	return candidates;
};
