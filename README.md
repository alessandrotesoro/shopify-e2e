# `@sematico/shopify-e2e`

An isolated Playwright lane for Shopify end-to-end tests.

The consumer owns `@playwright/test`, Chromium, its Shopify tests, and its trusted Playwright configuration. The CLI owns role-state capture, readiness checks, the selected roles and storage states, the dedicated test root, one-worker execution, and one visible Chromium instance for the command.

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
- `use.connectOptions`

`use.browserName`, when set, must be `chromium`. Firefox and WebKit are not supported.

Conflicts fail before Playwright starts. During a run, the CLI applies the validated absolute `testDir`, the exact selected-role filter, that role's storage-state object, and `workers: 1`. It also passes `--workers=1` as defense in depth.

Everything else remains normal Playwright behavior. This includes `testMatch`, `testIgnore`, `fullyParallel`, retries, repeats, timeouts, reporters, `outputDir`, traces, screenshots, videos, global setup and teardown, `webServer`, metadata, expect settings, and other valid root settings. Paths resolve from the real Shopify config because Playwright runs that file directly.

Compatible Chromium launch options from `use.launchOptions` are applied to the CLI-owned browser. The CLI always overrides browser signal handling, binds the native server to loopback on an ephemeral port, and forces `headless: false`. `use.channel` takes precedence over `use.launchOptions.channel`. Connection options, remote-debugging arguments, and headless Chromium arguments are rejected because the CLI owns the native connection and visible browser mode.

Playwright projects are intentionally unsupported in this phase. Arbitrary Playwright arguments, file selectors, project selectors, worker overrides, UI/debug controls, and reporter overrides are also unsupported.

## Configure the Shopify store

Create an ignored `.env` in the consumer root:

```dotenv
SHOPIFY_STORE_URL=https://your-store.myshopify.com/
SHOPIFY_STOREFRONT_PASSWORD=
```

Inherited shell values take precedence. Only the root `.env` is loaded; `.env.local` and parent files are ignored. The value must be an absolute HTTPS URL without credentials. Path, query, and fragment are discarded when the origin is normalized.

Role states are partitioned by normalized origin. A custom storefront domain and a `.myshopify.com` domain are separate partitions.

## Use the Playwright fixtures

Fixtures are manually attached to the consumer's own Playwright `test`. The package does not replace `test`, attach fixtures automatically, or unlock a storefront automatically:

```ts
import { expect, test as base } from "@playwright/test";
import {
	shopifyFixtures,
	type ShopifyFixtures,
} from "@sematico/shopify-e2e/playwright";

const test = base.extend<ShopifyFixtures>(shopifyFixtures);

test("opens a password-protected storefront", async ({ page, storefront }) => {
	await storefront.open();
	await storefront.unlock();

	await expect(page.locator("body")).toBeVisible();
});
```

`storefront.open()` navigates to the normalized `SHOPIFY_STORE_URL`. `storefront.unlock()` is always explicit. It safely does nothing when that storefront is already unlocked, without reading `SHOPIFY_STOREFRONT_PASSWORD`.

When a challenge exists, `unlock()` accepts only one visible, enabled `input[type="password"]` inside one visible `POST` form whose resolved destination is exactly the configured origin's `/password` URL. Partial, unrelated, multiple, query-bearing, or cross-origin password forms fail before the password is read or typed. The password comes from `SHOPIFY_STOREFRONT_PASSWORD`; it is never passed as a helper argument.

The CLI loads the consumer root `.env` before it starts Playwright, so fixtures used through `shopify-e2e run` receive those values. The package fixture module does not load dotenv itself. When running `npx playwright test` directly, the consumer must provide the variables through its shell, Playwright config, or its own environment loader.

The human-style typing primitive is also available directly:

```ts
import { typeLikeHuman } from "@sematico/shopify-e2e/playwright";

await typeLikeHuman(page.getByLabel("Email"), "person@example.com");
await typeLikeHuman(page.getByLabel("Search"), "summer products", {
	delay: 75,
});
```

`typeLikeHuman` emits sequential keyboard events with a deterministic delay. Do not use it for credentials while tracing is enabled: Playwright 1.61.1 traces may retain sequentially typed values. Credential-bearing traces must be treated as secrets and must never be committed or shared.

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
shopify-e2e run --role admin --role customer
shopify-e2e run --role customer --grep "account"
shopify-e2e run --role customer --grep-invert "draft"
```

`--role` is repeatable. Duplicate flags are ignored, and selected roles always run in the order declared by `roles` in `shopify-e2e.config.ts`.

In an interactive terminal, omitting `--role` opens one required multi-select containing configured roles that have valid state. In non-interactive use, at least one `--role` is required. Every selected role is validated before Chromium or Playwright starts, so one missing, invalid, stale, or unknown role prevents the whole run.

The CLI then opens one headed, consumer-provided Chromium instance and keeps it alive for the command. Roles run strictly one after another. Each role gets a normal Playwright CLI run, its own CLI-controlled storage state, and a fresh native browser connection. The previous role's Playwright process, package-managed contexts and pages, hooks, and connection must finish before the next role starts. No roles or tests run simultaneously through the package-managed path.

The mandatory role filter is combined with `--grep` and `--grep-invert`; these controls can only narrow every selected role lane. Execution always uses one global worker, even when `fullyParallel` is enabled.

The first failing role stops the run. Later roles are reported as `not-run`; completed roles remain `passed`, and an interrupted active role is `interrupted`. The CLI prints a config-ordered summary, closes its Chromium instance, and returns the authoritative signal, cleanup, infrastructure, or Playwright exit result.

Each role remains a separate normal Playwright run. Reporters, hooks, web servers, retries, traces, screenshots, videos, and `outputDir` are not rewritten or aggregated. A later role may therefore replace files written by an earlier role when the consumer config uses the same destinations.

This command is local-only and always headed. There is no CI, headless, CDP, attachment-to-existing-Chrome, parallel-role, or remote-execution contract.

## Doctor

```sh
shopify-e2e doctor
```

Doctor prints seven ordered checks: project, environment, store URL, Shopify config, Shopify test directory, Playwright peer, and Chromium. Results are `PASS`, `FAIL`, `ERROR`, or `SKIP`.

Doctor loads the trusted Shopify config and checks helper use, roles, protected conflicts, and path boundaries. Its directory scan only proves that the validated tree contains a regular JavaScript or TypeScript candidate, recursively excluding `node_modules` and rejecting symlinks. It does not import specs, apply `testMatch`/`testIgnore`, run hooks, start `webServer`, launch Chromium, or fully validate unprotected Playwright settings. Playwright remains authoritative during `run`.

## Trust and security

Consumer config, its imports, hooks, reporters, web server, and tests are trusted executable code. Config may execute once during CLI preflight and again in Playwright-owned main, loader, and worker processes. It must call `defineShopifyE2EConfig` on every evaluation and must not mutate protected values after the helper returns.

Saved storage state is a bearer secret. It can contain cookies, local storage, and captured IndexedDB for visited origins. Keep it outside the repository and never log or commit state, `.env`, reports, traces, screenshots, videos, or browser output.

Storefront passwords typed through `typeLikeHuman` may be recorded in Playwright 1.61.1 traces. Disable tracing for live credential acceptance runs, and delete any credential-bearing trace as sensitive data.

The CLI copies the selected state into an owner-only temporary execution context outside the consumer and package roots. Playwright receives the state object, never the long-lived registry path. The context remains available for Playwright-owned config evaluation and is removed after that role's direct Playwright child settles. The native browser endpoint is added only to the active child's environment and is never written into the execution context or command arguments.

Concurrent state-changing commands for the same role and origin are unsupported; callers must serialize them.

## Exit behavior

- `0`: success or cancellation without mutation; all doctor checks passed.
- `1`: package, browser, filesystem, or Playwright failure; unexpected doctor error.
- `2`: usage, config, URL, role, TTY, boundary, or peer preflight refusal; expected doctor failure.
- `130`: interrupted by `SIGINT` after required cleanup or rollback.
- `143`: interrupted by `SIGTERM` after required cleanup or rollback.
- Other numeric exits from the first failing Playwright role pass through unchanged.

## Version 0.7.0

Version 0.7.0 adds the manually attached `@sematico/shopify-e2e/playwright` fixture API, explicit password-protected storefront access, and reusable human-style typing. It preserves repeatable role selection and serial execution through one CLI-owned headed Chromium instance. It intentionally provides no automatic fixture attachment or unlocking, compatibility layer for unsupported profiles, Playwright projects, headless runs, CDP, or arbitrary Playwright argument passthrough.

## Verification

```sh
npm run verify
npm run test:browser:fixtures
npm run test:browser:roles
```

The browser gate requires a local graphical session and the consumer Playwright Chromium installation. The packed-consumer gate is also available separately:

```sh
npm run test:installed
```
