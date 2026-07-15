# `@sematico/shopify-e2e`

An isolated Playwright lane for Shopify end-to-end tests.

The consumer owns `@playwright/test`, Chromium, its Shopify tests, and its trusted Playwright configuration. The CLI owns role-state capture, readiness checks, the selected role and storage state, the dedicated test root, and one-worker execution.

## Install

```sh
npm install --save-dev @sematico/shopify-e2e @playwright/test@1.61.1
npx playwright install chromium
```

The supported peer range is `@playwright/test >=1.61.1 <1.62.0`; 1.61.1 is the tested baseline. The package pins its TypeScript config loader to Jiti 2.7.0. The CLI never installs browsers, calls `npx`, or falls back to its own development dependency.

## Configure

Create exactly one `shopify-e2e.config.ts` in the consumer root:

```ts
import { defineShopifyE2EConfig } from "@sematico/shopify-e2e/config";

export default defineShopifyE2EConfig({
	testDir: "tests/shopify-e2e",
	roles: ["admin", "customer", "guest"],

	// Normal Playwright configuration stays here.
	fullyParallel: true,
	retries: 1,
	reporter: [["html", { outputFolder: "playwright-report/shopify" }]],
	outputDir: "test-results/shopify",
	use: {
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},
});
```

CommonJS consumers can require the same helper from their TypeScript config:

```js
const { defineShopifyE2EConfig } = require("@sematico/shopify-e2e/config");

export default defineShopifyE2EConfig({
	testDir: "tests/shopify-e2e",
	roles: ["admin"],
});
```

The config must directly default-export the helper result. `roles` is a non-empty list of unique ASCII lower-kebab names, each at most 64 UTF-8 bytes. There is one saved browser state per role and store origin.

The CLI never discovers an ordinary `playwright.config.*`, never searches parent directories, and has no `--config` override. Both configs may coexist; only the root `shopify-e2e.config.ts` is loaded by this CLI.

### What the CLI enforces

The following settings belong to the CLI and must not be configured by the consumer:

- `projects`
- `workers`
- `grep`
- `grepInvert`
- `use.storageState`

Conflicts fail before Playwright starts. During a run, the CLI applies the validated absolute `testDir`, the exact selected-role filter, that role's storage-state object, and `workers: 1`. It also passes `--workers=1` as defense in depth.

Everything else remains normal Playwright behavior. This includes `testMatch`, `testIgnore`, `fullyParallel`, retries, repeats, timeouts, reporters, `outputDir`, traces, screenshots, videos, global setup and teardown, `webServer`, metadata, expect settings, and other valid root settings. Paths resolve from the real Shopify config because Playwright runs that file directly.

Playwright projects are intentionally unsupported in this phase. Arbitrary Playwright arguments, file selectors, project selectors, worker overrides, UI/debug controls, and reporter overrides are also unsupported.

## Configure the Shopify store

Create an ignored `.env` in the consumer root:

```dotenv
SHOPIFY_STORE_URL=https://your-store.myshopify.com/
```

Inherited shell or CI values take precedence. Only the root `.env` is loaded; `.env.local` and parent files are ignored. The value must be an absolute HTTPS URL without credentials. Path, query, and fragment are discarded when the origin is normalized.

Role states are partitioned by normalized origin. A custom storefront domain and a `.myshopify.com` domain are separate partitions.

## Tag tests by role

Use Playwright's native `tag` option:

```ts
import { expect, test } from "@playwright/test";

test(
	"admin can view orders",
	{ tag: "@shopify-e2e-role-admin" },
	async ({ page }) => {
		await expect(page).toHaveURL(/orders/);
	},
);

test(
	"shared account behavior",
	{ tag: ["@shopify-e2e-role-admin", "@shopify-e2e-role-customer"] },
	async ({ page }) => {
		await expect(page).toBeTruthy();
	},
);
```

The reserved `@shopify-e2e-role-<role>` token must appear only in `tag`, not in file paths, suite titles, or test titles. Files inside `testDir` may load during Playwright discovery even when their test bodies belong to another role; files outside `testDir` are never loaded.

## Authenticate roles

Use the interactive menu:

```sh
shopify-e2e auth
```

It offers Capture, Refresh, Remove, List, and Cancel with unavailable actions disabled. Direct commands are:

```sh
shopify-e2e auth capture
shopify-e2e auth capture --role customer
shopify-e2e auth refresh
shopify-e2e auth refresh --role customer
shopify-e2e auth remove
shopify-e2e auth remove --role customer
shopify-e2e auth remove --role customer --yes
shopify-e2e auth list
```

`--role` is the only selector. Capture and refresh always require an interactive terminal. They open a fresh, headed consumer-owned Chromium context; credentials and one-time codes are entered only in that browser. The CLI saves state only after terminal confirmation.

Capture requires missing state. Refresh requires valid existing state and atomically replaces it after confirmation. Declining or interrupting leaves the previous state unchanged.

Removal follows this exact matrix:

| Invocation | Interactive | Non-interactive |
|---|---|---|
| `auth remove` | Select a removable role, then confirm; default is no | Exit `2` |
| `auth remove --role <role>` | Confirm the role; default is no | Exit `2` |
| `auth remove --yes` | Select a removable role, then remove | Exit `2` |
| `auth remove --role <role> --yes` | Remove without prompts | Remove without prompts |

`auth list` is non-interactive and reports configured roles as `ready`, `missing`, or `invalid`, plus safe stored roles no longer in config as `orphaned`. It never exposes paths, origins, state, or credentials and does not resolve Playwright.

For a path-safe invalid state, remove and recapture it. Unsafe symlinks or non-directory collisions fail with manual-cleanup guidance; the CLI never follows or removes them.

## Run Shopify tests

```sh
shopify-e2e run --role customer
shopify-e2e run --role customer --grep "account"
shopify-e2e run --role customer --grep-invert "draft"
```

In an interactive terminal, omitting `--role` prompts once from configured roles that have valid state. In non-interactive use, `--role` is required. Missing, invalid, stale, or unknown roles fail before Playwright starts.

The mandatory role filter is combined with `--grep` and `--grep-invert`; these controls can only narrow the selected role lane. Execution always uses one global worker, even when `fullyParallel` is enabled.

For CI, provision the role-state data outside the repository through your machine image, encrypted cache, or another external workflow before running. This package does not import or remotely provision bearer secrets.

## Doctor

```sh
shopify-e2e doctor
```

Doctor prints seven ordered checks: project, environment, store URL, Shopify config, Shopify test directory, Playwright peer, and Chromium. Results are `PASS`, `FAIL`, `ERROR`, or `SKIP`.

Doctor loads the trusted Shopify config and checks helper use, roles, protected conflicts, and path boundaries. Its directory scan only proves that the validated tree contains a regular JavaScript or TypeScript candidate, recursively excluding `node_modules` and rejecting symlinks. It does not import specs, apply `testMatch`/`testIgnore`, run hooks, start `webServer`, launch Chromium, or fully validate unprotected Playwright settings. Playwright remains authoritative during `run`.

## Trust and security

Consumer config, its imports, hooks, reporters, web server, and tests are trusted executable code. Config may execute once during CLI preflight and again in Playwright-owned main, loader, and worker processes. It must call `defineShopifyE2EConfig` on every evaluation and must not mutate protected values after the helper returns.

Saved storage state is a bearer secret. It can contain cookies, local storage, and captured IndexedDB for visited origins. Keep it outside the repository and never log or commit state, `.env`, reports, traces, screenshots, videos, or browser output.

The CLI copies the selected state into an owner-only temporary execution context outside the consumer and package roots. Playwright receives the state object, never the long-lived registry path. The context remains available for Playwright-owned config evaluation and is removed after the direct Playwright child settles.

Concurrent state-changing commands for the same role and origin are unsupported; callers must serialize them.

## Exit behavior

- `0`: success or cancellation without mutation; all doctor checks passed.
- `1`: package, browser, filesystem, or Playwright failure; unexpected doctor error.
- `2`: usage, config, URL, role, TTY, boundary, or peer preflight refusal; expected doctor failure.
- `130`: interrupted by `SIGINT` after required cleanup or rollback.
- `143`: interrupted by `SIGTERM` after required cleanup or rollback.
- Other numeric Playwright child exits pass through unchanged.

## Breaking upgrade to 0.5.0

Version 0.5.0 intentionally has no compatibility or migration layer. Replace the old config with the helper-based roles list, recapture each role, and change automation to `--role`.

Old local named-profile data is ignored. If it is no longer needed, manually remove the obsolete `profiles` namespace from the package's platform application-data directory after stopping all CLI processes. Do not remove the new `role-states` namespace or sibling origin partitions.

## Verification

```sh
npm run verify
```

Optional real-browser role isolation:

```sh
npm run test:browser:roles
```
