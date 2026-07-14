import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import {
	ShopifyE2EInfrastructureError,
	ShopifyE2EPreflightError,
} from "../errors.js";
import { PACKAGE_ROOT } from "../package-root.js";
import { isPathContained } from "../path-boundary.utils.js";
import { assertProfileName } from "../profiles/profile-name.js";
import { serializeStorageState } from "../profiles/profile-schema.js";
import type { ProfileSelection } from "../profiles/profile-store.js";
import { buildRoleTokenPattern } from "../roles/role-token.js";

export interface GeneratedPlaywrightConfig {
	readonly cleanup: () => Promise<void>;
	readonly configPath: string;
}

export interface CreateGeneratedPlaywrightConfigOptions {
	readonly packageRoot?: string;
	readonly projectRoot?: string;
	readonly selection: ProfileSelection;
	readonly testDir: string;
}

export const createGeneratedPlaywrightConfig = async ({
	selection,
	testDir,
	packageRoot = PACKAGE_ROOT,
	projectRoot = dirname(testDir),
}: CreateGeneratedPlaywrightConfigOptions): Promise<GeneratedPlaywrightConfig> => {
	if (!isAbsolute(testDir)) {
		throw new ShopifyE2EPreflightError(
			"Generated Playwright config requires an absolute Shopify test directory",
		);
	}
	assertProfileName(selection.name);
	assertProfileName(selection.role, "Role name");
	if (
		selection.kind === "unauthenticated" &&
		selection.name !== selection.role
	) {
		throw new ShopifyE2EPreflightError(
			"Unauthenticated profile selection must use its configured role name",
		);
	}
	const serializedStorageState = serializeStorageState(selection.state);
	const rolePattern = buildRoleTokenPattern(selection.role);
	let physicalPackageRoot: string;
	let physicalProjectRoot: string;
	let physicalTemporaryRoot: string;
	try {
		[physicalTemporaryRoot, physicalProjectRoot, physicalPackageRoot] =
			await Promise.all([
				realpath(tmpdir()),
				realpath(projectRoot),
				realpath(packageRoot),
			]);
	} catch (error) {
		throw new ShopifyE2EInfrastructureError(
			"shopify-e2e could not complete Playwright execution",
			{ cause: error },
		);
	}
	if (
		isPathContained({
			candidate: physicalTemporaryRoot,
			parent: physicalProjectRoot,
		}) ||
		isPathContained({
			candidate: physicalTemporaryRoot,
			parent: physicalPackageRoot,
		})
	) {
		throw new ShopifyE2EPreflightError(
			"System temporary directory must resolve outside the consumer project and package installation",
		);
	}

	const directoryPath = await mkdtemp(
		join(physicalTemporaryRoot, "shopify-e2e-playwright-"),
	);
	const configPath = join(directoryPath, "playwright.config.mjs");
	try {
		await chmod(directoryPath, 0o700);
		await writeFile(
			configPath,
			`export default { testDir: ${JSON.stringify(testDir)}, workers: 1, grep: new RegExp(${JSON.stringify(rolePattern.source)}, ${JSON.stringify(rolePattern.flags)}), use: { storageState: JSON.parse(${JSON.stringify(serializedStorageState)}) } };\n`,
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
