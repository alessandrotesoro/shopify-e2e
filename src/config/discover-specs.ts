import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { ShopifyE2EPreflightError } from "../errors.js";

const playwrightDefaultSpecName = /\.(?:spec|test)\.(?:[cm]?[jt]sx?)$/;

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
				entry.name !== ".gitignore" &&
				playwrightDefaultSpecName.test(entry.name)
			) {
				candidates.push(entryPath);
			}
		}
	};

	await visit(testDir);
	candidates.sort((left, right) => left.localeCompare(right));
	if (candidates.length === 0) {
		throw new ShopifyE2EPreflightError(
			`Shopify test directory contains no runnable Playwright specs: ${testDir}`,
		);
	}
	return candidates;
};
