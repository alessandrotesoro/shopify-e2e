import { isAbsolute } from "node:path";

export const SHOPIFY_E2E_EXECUTION_CONTEXT_ENV =
	"SHOPIFY_E2E_EXECUTION_CONTEXT";

export const RESERVED_EXECUTION_ENVIRONMENT_KEYS = Object.freeze([
	SHOPIFY_E2E_EXECUTION_CONTEXT_ENV,
] as const);

export const assertReservedExecutionEnvironmentIsClear = (
	environment: NodeJS.ProcessEnv,
): void => {
	for (const key of RESERVED_EXECUTION_ENVIRONMENT_KEYS) {
		if (Object.hasOwn(environment, key)) {
			throw new TypeError(
				`Reserved Shopify E2E execution environment key must not be set: ${key}`,
			);
		}
	}
};

export const buildPlaywrightChildEnvironment = (
	parentEnvironment: NodeJS.ProcessEnv,
	contextPath: string,
): NodeJS.ProcessEnv => {
	if (!isAbsolute(contextPath)) {
		throw new TypeError(
			"Shopify E2E execution context pointer must be an absolute path",
		);
	}
	const childEnvironment = { ...parentEnvironment };
	for (const key of RESERVED_EXECUTION_ENVIRONMENT_KEYS) {
		delete childEnvironment[key];
	}
	childEnvironment[SHOPIFY_E2E_EXECUTION_CONTEXT_ENV] = contextPath;
	return childEnvironment;
};
