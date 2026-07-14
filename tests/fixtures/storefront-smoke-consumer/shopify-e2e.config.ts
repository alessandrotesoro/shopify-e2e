export default {
	testDir: "shopify-smoke",
	roles: {
		guest: { authentication: "none" },
		"storefront-access": { authentication: "required" },
	},
};
