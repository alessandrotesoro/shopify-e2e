import { Command, Flags } from "@oclif/core";

import { executeAuthCommand } from "../auth.js";

export class AuthRemove extends Command {
	static override description =
		"Remove one saved role-keyed browser-authentication state for the configured Shopify store.";

	static override examples = [
		"<%= config.bin %> <%= command.id %>",
		"<%= config.bin %> <%= command.id %> --role admin",
		"<%= config.bin %> <%= command.id %> --role admin --yes",
	];

	static override flags = {
		role: Flags.string({
			description: "Role state name (ASCII lower-kebab, max 64 UTF-8 bytes)",
		}),
		yes: Flags.boolean({
			description:
				"Skip confirmation. Non-interactive removal requires --role and --yes.",
		}),
	};

	static override strict = true;

	public async run(): Promise<void> {
		const { flags } = await this.parse(AuthRemove);
		await executeAuthCommand({
			action: "remove",
			command: this,
			role: flags.role,
			yes: flags.yes,
		});
	}
}
