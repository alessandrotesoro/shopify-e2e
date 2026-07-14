# `@sematico/shopify-e2e`

A CLI-first, isolated Playwright lane for Shopify end-to-end tests.

Version 0.2 adds local browser profiles and role-scoped runs. The consuming application owns `@playwright/test`, Chromium, its Shopify tests, and its trusted configuration. The CLI owns profile capture, isolated test discovery, one-worker execution, and the allowed run controls.

## Install

```sh
npm install --save-dev @sematico/shopify-e2e @playwright/test@1.61.1
npx playwright install chromium
```

The supported peer range is `@playwright/test >=1.61.1 <1.62.0`. The CLI never installs a browser, calls `npx`, or falls back to its development dependency.

## Configure roles and the Shopify test root

Create `shopify-e2e.config.ts` in the directory where the CLI will run:

```ts
export default {
	testDir: "tests/shopify-e2e",
	roles: {
		admin: { authentication: "required" },
		customer: { authentication: "required" },
		guest: { authentication: "none" },
	},
};
```

The default export must contain exactly `testDir` and a non-empty `roles` object. Role names must be ASCII lower-kebab strings no longer than 64 UTF-8 bytes. Each role has exactly one authentication value:

- `required` means developers capture one or more saved browser profiles for that role.
- `none` creates a synthetic profile with explicit empty browser state and writes nothing to the profile registry.

A role names a test lane; a saved profile is one captured browser identity assigned to an authenticated role. Multiple profiles can therefore run the same role-tagged tests without duplicating role configuration.

This is a breaking change from 0.1: `{ testDir }` alone is invalid and must be migrated explicitly. The config key order does not matter.

### Migrate from 0.1 to 0.2

- Add an explicit `roles` object to `shopify-e2e.config.ts`.
- Set `SHOPIFY_STORE_URL` in the consumer's ignored `.env` file.
- Tag every Shopify spec with its configured `@shopify-e2e-role-<role>` lane.
- For each role, either capture a profile for `authentication: "required"` or configure it as `authentication: "none"`.
- Pass `--profile <name>` to every non-interactive `run` invocation.

The CLI discovers `./shopify-e2e.config.ts` by convention. `--config` may select another contained TypeScript config. Config is trusted consumer code and is not sandboxed.

## Configure the Shopify origin

Create an ignored `.env` in the invocation directory:

```dotenv
SHOPIFY_STORE_URL=https://your-store.myshopify.com/
```

`auth` and `run` require an absolute HTTPS URL from inherited environment or this one `.env` file. The CLI normalizes it to its origin: user information is rejected, while path, query, and fragment are discarded. It does not search parent directories, load `.env.local`, prompt for the URL, or edit environment files. Inherited values take precedence over `.env`.

Profiles are partitioned by this normalized configured origin. A custom storefront domain and its `.myshopify.com` domain are separate partitions; the CLI does not guess that they represent the same Shopify shop.

## Tag tests with roles

Use Playwright's native `tag` option:

```ts
import { expect, test } from "@playwright/test";

test(
	"admin can view orders",
	{ tag: "@shopify-e2e-role-admin" },
	async ({ page }) => {
		// ...
	},
);

test(
	"shared account behavior",
	{
		tag: [
			"@shopify-e2e-role-admin",
			"@shopify-e2e-role-customer",
		],
	},
	async ({ page }) => {
		await expect(page).toHaveURL(/./);
	},
);
```

The reserved `@shopify-e2e-role-<role>` text must appear only as a tag—not in spec paths, suite titles, or test titles. Playwright matches one combined path/title/tag string, so this convention is an orchestration boundary for trusted tests, not a sandbox against deliberately overriding spec code. Files inside `testDir` can be imported during Playwright discovery even when their test bodies belong to another role; files outside `testDir` are never loaded.

## Capture and inspect profiles

Run the interactive auth menu:

```sh
shopify-e2e auth
```

It offers capture, refresh, list, and cancel. Direct equivalents are:

```sh
shopify-e2e auth capture
shopify-e2e auth capture --role customer --profile customer-primary
shopify-e2e auth refresh
shopify-e2e auth refresh --profile customer-primary
shopify-e2e auth list
```

The complete auth surface is `auth [--config <path>]`, `auth capture [--config <path>] [--role <role>] [--profile <name>]`, `auth refresh [--config <path>] [--profile <name>]`, and `auth list [--config <path>]`. These commands accept no positional arguments.

Capture and refresh require an interactive terminal. Missing role/profile values are prompted; supplied values are validated without prompting. `auth list` works non-interactively and never loads Playwright.

Capture opens a fresh, headed, non-persistent consumer-owned Chromium context. Enter storefront passwords, Shopify credentials, and one-time codes only in that browser window. The CLI never asks for credentials and never tries to detect when login is complete. Return to the terminal and explicitly confirm when the browser state should be saved.

Refresh starts another fresh context using only the selected profile's prior state and atomically replaces that state after confirmation. Declining, closing the browser, or cancelling leaves the previous profile unchanged.

Profile names must be ASCII lower-kebab strings no longer than 64 UTF-8 bytes. Choose pseudonymous names such as `customer-primary`; do not put names, email addresses, credentials, or other personal data in a profile name.

## Run a profile's tests

In an interactive terminal:

```sh
shopify-e2e run
```

`run` shows exactly one profile prompt. Saved choices appear as `<profile> - <role>` and unauthenticated choices as `<role> - unauthenticated`. It then starts immediately.

For deterministic or non-interactive use, select explicitly:

```sh
shopify-e2e run --profile customer-primary
shopify-e2e run --profile guest
```

The generated owner-only config contains the selected state by value, the mandatory exact role filter, the dedicated absolute `testDir`, and one worker. Playwright never receives the long-lived profile path. Existing title controls only narrow that role lane:

```sh
shopify-e2e run --profile customer-primary --grep "account"
shopify-e2e run --profile admin-primary --grep-invert "draft order"
```

Projects, file selectors, reporters, worker overrides, UI/debug modes, retries, shards, and unrestricted passthrough remain unavailable.

The complete run surface is `run [--config <path>] [--profile <name>] [--grep <pattern>] [--grep-invert <pattern>]`; `-g` is the short form of `--grep`.

## Profile storage and security

Saved state lives outside the consuming repository under oclif's platform application-data directory, partitioned by configured origin. `SHOPIFY_E2E_DATA_DIR` may override that root for a scoped local setup, but the resolved root must remain outside both the consumer and package installation.

Storage state is a bearer secret. It can contain cookies, localStorage, and captured IndexedDB for every origin visited in the dedicated capture context. It does not include sessionStorage, passkeys, or browser cache, does not guarantee origin exclusivity, and does not guarantee that Shopify authentication remains valid.

Do not commit or log profile state, `.env`, screenshots, traces, or browser output. If a profile may be compromised, revoke the Shopify session first, then manually remove that profile or the CLI application-data root. A deletion command and automatic stale temporary-artifact cleanup are deferred. Crash or `SIGKILL` remnants remain owner-only but may need manual removal.

The boundary protects against accidental commits, cross-origin/profile mixups, partial replacement, and unrelated out-of-root test loading. It does not protect against malicious consumer config/spec code, a compromised Playwright/browser dependency, concurrent writers, or another process running as the same OS user.

## Exit behavior

- `0`: success, menu cancellation, declined save, or browser closure before save.
- `1`: package/browser/filesystem infrastructure failure, or Playwright's own test/no-test failure.
- `2`: usage, config, URL, profile, TTY, boundary, or peer preflight failure.
- `130`: terminal Ctrl+C or `SIGINT` after cleanup.
- `143`: `SIGTERM` after cleanup.
- Other numeric Playwright child exits pass through unchanged.

## Verification

```sh
npm run test:installed
npm run verify
```

These deterministic gates are browserless and do not contact Shopify or a storefront. Packed consumer installation may use the configured npm registry or cache. No CI workflow is part of this phase.

The optional local Chromium isolation probe is separate:

```sh
npm run test:browser:profiles
```

It installs the packed CLI into a temporary consumer and uses only a loopback HTTP origin to prove A-B-guest-A cookie, localStorage, and IndexedDB isolation. It does not weaken the production HTTPS URL requirement.

The [Levelogy manual consumer](tests/fixtures/storefront-smoke-consumer/README.md) covers the password-protected Shopify acceptance flow and is intentionally excluded from deterministic verification.
