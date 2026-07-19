export const SHOPIFY_LAUNCH_OPTION_KEYS = Object.freeze([
	"args",
	"artifactsDir",
	"channel",
	"chromiumSandbox",
	"downloadsPath",
	"env",
	"executablePath",
	"handleSIGHUP",
	"handleSIGINT",
	"handleSIGTERM",
	"headless",
	"ignoreDefaultArgs",
	"proxy",
	"timeout",
] as const);

export type ShopifyLaunchOptionKey =
	(typeof SHOPIFY_LAUNCH_OPTION_KEYS)[number];
