import { Command, Flags } from "@oclif/core";

import {
	configFlags,
	configOverridesFromFlags,
} from "../../cli-config-flags.js";
import {
	authProfileStorageStatePath,
	validateAuthProfileName,
} from "../../config/primitives.js";
import { resolveShopifyE2EConfig } from "../../shopify-e2e-config.js";
import { captureShopifyAuthProfile } from "../../shopify-session.js";

export default class AuthSave extends Command {
	static flags = {
		...configFlags,
		empty: Flags.boolean({
			description: "Start capture from empty browser storage.",
			exclusive: ["from-auth-profile"],
		}),
		"from-auth-profile": Flags.string({
			description: "Seed capture from another named auth profile.",
			exclusive: ["empty"],
		}),
	};

	static summary = "Interactively capture a named Shopify auth profile.";

	async run(): Promise<void> {
		const { flags } = await this.parse(AuthSave);
		const config = await resolveShopifyE2EConfig(
			configOverridesFromFlags(flags),
		);
		const baseName = flags["from-auth-profile"];
		const fromAuthProfile = baseName
			? {
					name: validateAuthProfileName(baseName),
					storageStatePath: authProfileStorageStatePath(
						config.cwd,
						baseName,
					),
				}
			: undefined;
		const result = await captureShopifyAuthProfile(config, {
			empty: Boolean(flags.empty),
			fromAuthProfile,
			log: (message) => this.log(message),
			warn: (message) => this.warn(message),
		});

		this.log(
			result.saved
				? `Saved Shopify auth profile ${JSON.stringify(result.profile.name)} to ${result.profile.storageStatePath}.`
				: `Cancelled Shopify auth profile ${JSON.stringify(result.profile.name)} without saving.`,
		);
	}
}
