export default {
	testDir: "shopify-smoke",
	roles: {
		customer: { authentication: "required" },
		guest: { authentication: "none" },
	},
};
