import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { ShopifyE2EPreflightError } from "../errors.js";

export interface GeneratedPlaywrightConfig {
	readonly cleanup: () => Promise<void>;
	readonly configPath: string;
}

export const createGeneratedPlaywrightConfig = async (
	testDir: string,
): Promise<GeneratedPlaywrightConfig> => {
	if (!isAbsolute(testDir)) {
		throw new ShopifyE2EPreflightError(
			"Generated Playwright config requires an absolute Shopify test directory",
		);
	}

	const directoryPath = await mkdtemp(
		join(tmpdir(), "shopify-e2e-playwright-"),
	);
	const configPath = join(directoryPath, "playwright.config.mjs");
	try {
		await chmod(directoryPath, 0o700);
		await writeFile(
			configPath,
			`export default { testDir: ${JSON.stringify(testDir)}, workers: 1 };\n`,
			{ flag: "wx", mode: 0o600 },
		);
		await chmod(configPath, 0o600);
	} catch (error) {
		await rm(directoryPath, { force: true, recursive: true });
		throw error;
	}

	return {
		cleanup: () => rm(directoryPath, { force: true, recursive: true }),
		configPath,
	};
};
