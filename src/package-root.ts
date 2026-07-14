import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Physical package root in both the source tree and compiled distribution. */
export const PACKAGE_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
);
