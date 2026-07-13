import { resolve } from "node:path";

import { configDotenv } from "dotenv";

import { resolveProjectRoot } from "../config/project-boundary.js";
import { ShopifyE2EPreflightError } from "../errors.js";

export interface LoadEnvironmentOptions {
	readonly cwd: string;
	readonly environment: NodeJS.ProcessEnv;
}

export const loadEnvironment = async ({
	cwd,
	environment,
}: LoadEnvironmentOptions): Promise<void> => {
	const projectRoot = await resolveProjectRoot(cwd);
	const result = configDotenv({
		override: false,
		path: resolve(projectRoot, ".env"),
		processEnv: environment,
		quiet: true,
	});
	const error = result.error as NodeJS.ErrnoException | undefined;

	if (!error || error.code === "ENOENT") return;

	throw new ShopifyE2EPreflightError("Consumer .env could not be read");
};
