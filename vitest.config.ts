import { defineConfig } from "vitest/config";

export default defineConfig({
	esbuild: {
		include: /\.[cm]?[jt]sx?$/,
	},
	test: {
		coverage: { enabled: false },
		include: ["tests/**/*.test.ts"],
	},
});
