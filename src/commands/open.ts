import { Command, Flags } from "@oclif/core";
import { configFlags, configOverridesFromFlags } from "../cli-config-flags.js";
import { resolveShopifyE2EConfig } from "../shopify-e2e-config.js";
import {
	disconnectLiveShopifySession,
	prepareShopifySession,
} from "../shopify-session.js";

export default class Open extends Command {
	static flags = {
		...configFlags,
		wait: Flags.boolean({
			allowNo: true,
			default: true,
			description: "Wait and poll until Shopify Admin login is ready.",
		}),
	};

	static summary = "Open Shopify Admin in a reusable Chrome CDP session.";

	async run(): Promise<void> {
		const { flags } = await this.parse(Open);
		const config = await resolveShopifyE2EConfig(
			configOverridesFromFlags(flags),
		);

		try {
			const session = await prepareShopifySession(config, {
				log: (message) => this.log(message),
				waitForLogin: flags.wait,
			});

			this.log(
				session.chromeStarted
					? `Chrome opened with CDP at ${config.cdpUrl}`
					: `Chrome CDP is already reachable at ${config.cdpUrl}`,
			);
			this.log(`Profile directory: ${config.chromeProfilePath}`);
			this.log(
				session.authStateSaved
					? `Auth state saved to ${session.authStatePath}`
					: "Auth state was not saved because Shopify Admin was not confirmed logged in.",
			);
			this.log(`Current page: ${session.page.url()}`);
		} finally {
			await disconnectLiveShopifySession();
		}
	}
}
