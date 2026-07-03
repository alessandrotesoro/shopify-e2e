import { Command } from "@oclif/core";

import { configFlags, configOverridesFromFlags } from "../../command-flags.js";
import { resolveShopifyE2EConfig } from "../../config.js";
import { prepareShopifySession } from "../../shopify-session.js";

export default class AuthSave extends Command {
	static flags = configFlags;
	static summary = "Save Shopify auth state from the Chrome CDP session.";

	async run(): Promise<void> {
		const { flags } = await this.parse(AuthSave);
		const config = await resolveShopifyE2EConfig(configOverridesFromFlags(flags));
		const session = await prepareShopifySession(config, {
			log: (message) => this.log(message),
			saveAuthState: true,
			waitForLogin: true,
		});

		this.log(`Saved Shopify auth state to ${session.authStatePath}`);
	}
}
