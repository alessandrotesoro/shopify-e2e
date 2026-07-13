export default {
	testDir:
		process.env.SHOPIFY_E2E_DOTENV_SENTINEL ===
		process.env.SHOPIFY_E2E_DOTENV_EXPECTED
			? "shopify-dotenv"
			: "missing-shopify-dotenv",
};
