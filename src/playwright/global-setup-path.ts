import { fileURLToPath } from "node:url";

export const globalSetupPath = fileURLToPath(
	new URL("./global-setup.js", import.meta.url),
);
