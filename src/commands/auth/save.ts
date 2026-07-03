import { Command } from "@oclif/core";

import { saveAuthState } from "../../auth-state.js";
import { configFlags, configOverridesFromFlags } from "../../command-flags.js";
import { resolveShopifyE2EConfig } from "../../config.js";

export default class AuthSave extends Command {
	static flags = configFlags;
	static summary = "Save Shopify auth state from the Chrome CDP session.";

	async run(): Promise<void> {
		const { flags } = await this.parse(AuthSave);
		const config = await resolveShopifyE2EConfig(configOverridesFromFlags(flags));
		const result = await saveAuthState(config);

		this.log(`Saved Shopify auth state to ${result.path}`);
	}
}
