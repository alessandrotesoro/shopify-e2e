import { Command } from "@oclif/core";

import { configFlags, configOverridesFromFlags } from "../cli-config-flags.js";
import { waitForInteractiveConfirmation } from "../interactive-session.js";
import { resolveShopifyE2EConfig } from "../shopify-e2e-config.js";
import { prepareShopifySession } from "../shopify-session.js";

export default class Open extends Command {
	static flags = configFlags;
	static summary = "Inspect a named Shopify auth profile in isolation.";

	async run(): Promise<void> {
		const { flags } = await this.parse(Open);
		const config = await resolveShopifyE2EConfig(
			configOverridesFromFlags(flags),
		);
		const session = await prepareShopifySession(config, {
			waitForLogin: false,
		});

		try {
			this.log(
				`Inspecting Shopify auth profile ${JSON.stringify(config.authProfile.name)} from ${config.authProfile.storageStatePath}.`,
			);
			this.log(
				"Press Enter, close the inspection page, or press Ctrl-C to finish.",
			);
			await waitForInteractiveConfirmation({ page: session.page });
		} finally {
			await session.close();
		}
	}
}
