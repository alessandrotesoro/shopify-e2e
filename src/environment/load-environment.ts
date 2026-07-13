import { resolve } from "node:path";

import { configDotenv, populate } from "dotenv";

import { resolveProjectRoot } from "../config/project-boundary.js";
import { ShopifyE2EPreflightError } from "../errors.js";

export interface LoadEnvironmentOptions {
	readonly cwd: string;
	readonly environment: NodeJS.ProcessEnv;
}

export const loadEnvironment = async ({
	cwd,
	environment,
}: LoadEnvironmentOptions): Promise<string> => {
	const projectRoot = await resolveProjectRoot(cwd);
	const stagingEnvironment: NodeJS.ProcessEnv = {
		DOTENV_CONFIG_DEBUG: "",
		DOTENV_CONFIG_QUIET: "true",
	};
	const result = configDotenv({
		override: false,
		path: resolve(projectRoot, ".env"),
		processEnv: stagingEnvironment,
		quiet: true,
	});
	const error = result.error as NodeJS.ErrnoException | undefined;

	if (error?.code === "ENOENT") return projectRoot;
	if (error) {
		throw new ShopifyE2EPreflightError("Consumer .env could not be read");
	}

	populate(environment, result.parsed ?? {}, { override: false });
	return projectRoot;
};
