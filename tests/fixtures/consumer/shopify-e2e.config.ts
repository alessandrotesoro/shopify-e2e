export default {
	testDir: "shopify-passing",
	roles: {
		admin: { authentication: "required" },
		customer: { authentication: "required" },
		guest: { authentication: "none" },
	},
};
