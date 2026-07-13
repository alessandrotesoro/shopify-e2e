import { resolve } from "node:path";

import { configDotenv } from "dotenv";

import { resolveProjectRoot } from "../config/project-boundary.js";
import { ShopifyE2EPreflightError } from "../errors.js";

export interface LoadEnvironmentOptions {
	readonly cwd: string;
	readonly environment: NodeJS.ProcessEnv;
}

const getErrorCode = (error: unknown): unknown => {
	if (typeof error !== "object" || error === null) return undefined;
	return Reflect.get(error, "code");
};

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

	if (!result.error || getErrorCode(result.error) === "ENOENT") return;

	throw new ShopifyE2EPreflightError("Consumer .env could not be read");
};
