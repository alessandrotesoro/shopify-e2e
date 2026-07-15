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
