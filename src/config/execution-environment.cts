import { isAbsolute } from "node:path";

export const SHOPIFY_E2E_EXECUTION_CONTEXT_ENV =
	"SHOPIFY_E2E_EXECUTION_CONTEXT";

// Playwright 1.61.x maps these documented test-runner variables to the public
// use.connectOptions fixture path. Keep the names centralized so peer-version
// support cannot widen without exercising this boundary.
export const PLAYWRIGHT_CONNECTION_ENVIRONMENT_KEYS = Object.freeze([
	"PW_TEST_CONNECT_WS_ENDPOINT",
	"PW_TEST_CONNECT_HEADERS",
	"PW_TEST_CONNECT_EXPOSE_NETWORK",
] as const);

export const RESERVED_EXECUTION_ENVIRONMENT_KEYS = Object.freeze([
	SHOPIFY_E2E_EXECUTION_CONTEXT_ENV,
	...PLAYWRIGHT_CONNECTION_ENVIRONMENT_KEYS,
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
	wsEndpoint?: string,
): NodeJS.ProcessEnv => {
	if (!isAbsolute(contextPath)) {
		throw new TypeError(
			"Shopify E2E execution context pointer must be an absolute path",
		);
	}
	for (const key of PLAYWRIGHT_CONNECTION_ENVIRONMENT_KEYS) {
		if (Object.hasOwn(parentEnvironment, key)) {
			throw new TypeError(
				`Reserved Playwright connection environment key must not be set: ${key}`,
			);
		}
	}
	if (
		wsEndpoint !== undefined &&
		(typeof wsEndpoint !== "string" || wsEndpoint.length === 0)
	) {
		throw new TypeError("Playwright native connection endpoint must be set");
	}
	const childEnvironment = { ...parentEnvironment };
	for (const key of RESERVED_EXECUTION_ENVIRONMENT_KEYS) {
		delete childEnvironment[key];
	}
	childEnvironment[SHOPIFY_E2E_EXECUTION_CONTEXT_ENV] = contextPath;
	if (wsEndpoint !== undefined) {
		childEnvironment.PW_TEST_CONNECT_WS_ENDPOINT = wsEndpoint;
	}
	return childEnvironment;
};
