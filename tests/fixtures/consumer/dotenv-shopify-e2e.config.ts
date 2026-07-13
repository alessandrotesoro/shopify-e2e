export default {
	testDir:
		process.env.SHOPIFY_E2E_DOTENV_SENTINEL ===
			process.env.SHOPIFY_E2E_DOTENV_EXPECTED &&
		process.env.DOTENV_CONFIG_DEBUG ===
			process.env.SHOPIFY_E2E_DOTENV_EXPECTED_DEBUG &&
		process.env.DOTENV_CONFIG_QUIET ===
			process.env.SHOPIFY_E2E_DOTENV_EXPECTED_QUIET
			? "shopify-dotenv"
			: "missing-shopify-dotenv",
};
