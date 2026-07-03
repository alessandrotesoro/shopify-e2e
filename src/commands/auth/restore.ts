import { Command } from "@oclif/core";

import { restoreAuthState } from "../../auth-state.js";
import { ensureChrome } from "../../browser.js";
import { configFlags, configOverridesFromFlags } from "../../command-flags.js";
import { missingLiveShopifyPrerequisites, resolveShopifyE2EConfig } from "../../config.js";
import { adminStoreUrl } from "../../urls.js";

export default class AuthRestore extends Command {
	static flags = configFlags;
	static summary = "Restore saved Shopify auth state into the Chrome CDP session.";

	async run(): Promise<void> {
		const { flags } = await this.parse(AuthRestore);
		const config = await resolveShopifyE2EConfig(configOverridesFromFlags(flags));
		const missing = missingLiveShopifyPrerequisites(config, { requireAppUrl: false });

		if (missing.length > 0) {
			this.error(`Missing live Shopify e2e prerequisites: ${missing.join(", ")}`);
		}

		await ensureChrome(config, adminStoreUrl(config.shopDomain as string));

		const result = await restoreAuthState(config);

		this.log(
			result.restored
				? `Restored Shopify auth state from ${result.path}`
				: `No Shopify auth state found at ${result.path}`,
		);
	}
}
