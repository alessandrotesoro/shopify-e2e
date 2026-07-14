import { Command, Flags } from "@oclif/core";

import { configFlag } from "../../flags.js";
import { executeAuthCommand } from "../auth.js";

export class AuthRemove extends Command {
	static override description =
		"Remove one saved browser-authentication profile for the configured Shopify store.";

	static override examples = [
		"<%= config.bin %> <%= command.id %>",
		"<%= config.bin %> <%= command.id %> --profile admin-primary",
		"<%= config.bin %> <%= command.id %> --profile admin-primary --yes",
	];

	static override flags = {
		config: configFlag,
		profile: Flags.string({
			description: "Saved profile name (ASCII lower-kebab, max 64 UTF-8 bytes)",
		}),
		yes: Flags.boolean({
			description:
				"Skip confirmation. Non-interactive removal requires --profile and --yes.",
		}),
	};

	static override strict = true;

	public async run(): Promise<void> {
		const { flags } = await this.parse(AuthRemove);
		await executeAuthCommand({
			action: "remove",
			command: this,
			configPath: flags.config,
			profile: flags.profile,
			yes: flags.yes,
		});
	}
}
