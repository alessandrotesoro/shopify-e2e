import { Command, Flags } from "@oclif/core";

import { executeAuthCommand } from "../auth.js";

export class AuthCapture extends Command {
	static override description =
		"Capture browser authentication state for one configured role in consumer-owned headed Chromium. The CLI never asks for credentials.";

	static override examples = [
		"<%= config.bin %> <%= command.id %> --role admin",
	];

	static override flags = {
		role: Flags.string({
			description: "Configured role (ASCII lower-kebab, max 64 UTF-8 bytes)",
		}),
	};

	static override strict = true;

	public async run(): Promise<void> {
		const { flags } = await this.parse(AuthCapture);
		await executeAuthCommand({
			action: "capture",
			command: this,
			role: flags.role,
		});
	}
}
