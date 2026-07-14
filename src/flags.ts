import { Flags } from "@oclif/core";

export const configFlag = Flags.string({
	description:
		"Path to a dedicated Shopify configuration inside the consuming project",
});
