import { Command, Flags } from "@oclif/core";

import { executeAuthCommand } from "../auth.js";

export class AuthRefresh extends Command {
	static override description =
		"Refresh browser authentication state for one configured role in consumer-owned headed Chromium.";

	static override examples = [
		"<%= config.bin %> <%= command.id %> --role customer",
	];

	static override flags = {
		role: Flags.string({
			description: "Configured role (ASCII lower-kebab, max 64 UTF-8 bytes)",
		}),
	};

	static override strict = true;

	public async run(): Promise<void> {
		const { flags } = await this.parse(AuthRefresh);
		await executeAuthCommand({
			action: "refresh",
			command: this,
			role: flags.role,
		});
	}
}
