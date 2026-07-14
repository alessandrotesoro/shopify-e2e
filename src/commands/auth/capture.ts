import { Command, Flags } from "@oclif/core";

import { configFlag, executeAuthCommand } from "../auth.js";

export class AuthCapture extends Command {
	static override description =
		"Capture a named authenticated profile in consumer-owned headed Chromium. The CLI never asks for credentials.";

	static override examples = [
		"<%= config.bin %> <%= command.id %> --role admin --profile admin-primary",
	];

	static override flags = {
		config: configFlag,
		profile: Flags.string({
			description: "New profile name (ASCII lower-kebab, max 64 UTF-8 bytes)",
		}),
		role: Flags.string({
			description:
				"Configured authenticated role (ASCII lower-kebab, max 64 UTF-8 bytes)",
		}),
	};

	static override strict = true;

	public async run(): Promise<void> {
		const { flags } = await this.parse(AuthCapture);
		await executeAuthCommand({
			action: "capture",
			command: this,
			configPath: flags.config,
			profile: flags.profile,
			role: flags.role,
		});
	}
}
