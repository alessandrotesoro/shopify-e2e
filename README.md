# `@sematico/shopify-e2e`

A CLI-first, isolated Playwright lane for Shopify end-to-end tests.

Version 0.4 adds a local, read-only readiness doctor. Version 0.3 added safe local removal of saved browser profiles. The consuming application owns `@playwright/test`, Chromium, its Shopify tests, and its trusted configuration. The CLI owns readiness reporting, profile capture and removal, isolated test discovery, one-worker execution, and the allowed run controls.

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

Upgrading from 0.2 to 0.3 requires no config or test changes. The only new public surface is `auth remove`. Upgrading from 0.3 to 0.4 also requires no config or test changes; the new public surface is `doctor [--config <path>]`.

The CLI discovers `./shopify-e2e.config.ts` by convention. `--config` may select another contained TypeScript config. Config is trusted consumer code and is not sandboxed.

## Configure the Shopify origin

Create an ignored `.env` in the invocation directory:

```dotenv
SHOPIFY_STORE_URL=https://your-store.myshopify.com/
```

`auth` and `run` require an absolute HTTPS URL from inherited environment or this one `.env` file. The CLI normalizes it to its origin: user information is rejected, while path, query, and fragment are discarded. It does not search parent directories, load `.env.local`, prompt for the URL, or edit environment files. Inherited values take precedence over `.env`.

Profiles are partitioned by this normalized configured origin. A custom storefront domain and its `.myshopify.com` domain are separate partitions; the CLI does not guess that they represent the same Shopify shop.

## Diagnose local readiness

Inspect the shared pre-profile prerequisites from the intended consumer root:

```sh
shopify-e2e doctor
shopify-e2e doctor --config path/to/shopify-e2e.config.ts
```

The complete surface is `doctor [--config <path>]`. It accepts no positional arguments, aliases, prompts, or other flags. The report is human-facing text in this fixed order:

| Check | `PASS` means |
|---|---|
| Project | The physical invocation directory is a usable consumer root. |
| Environment | The root `.env` was absent or loaded while preserving inherited values. |
| Store URL | `SHOPIFY_STORE_URL` is an absolute HTTPS URL without user information and trusted config kept its normalized origin stable. |
| Shopify config | The dedicated config loaded and passed the same path and `{ testDir, roles }` validation used by the other commands. |
| Shopify spec candidates | Filename-only discovery found Playwright-compatible candidates inside the dedicated `testDir`; no spec was imported. |
| Playwright peer | The consumer's own public `@playwright/test` entry and declared CLI satisfy `>=1.61.1 <1.62.0`; the package development dependency is never a fallback. |
| Chromium | `chromium.executablePath()` names a regular file. No browser was launched. |

Each row is `PASS`, `FAIL`, `ERROR`, or `SKIP`. `FAIL` is an expected local setup problem, `ERROR` is a sanitized unexpected inspection failure, and `SKIP` means a prerequisite did not pass. The command prints all independent results before exiting: `0` means all seven checks passed, `2` means at least one expected readiness failure and no internal error, and `1` means an unexpected inspection error took precedence. There is no JSON, quiet, verbose, debug, or repair mode.

Doctor is observational: it does not create profiles or generated Playwright config, run tests, launch or install Chromium, prompt, repair files, or contact Shopify. Loading the dedicated config and the verified consumer Playwright public module does execute trusted consumer-owned code; those modules are not sandboxed and can have their own side effects.

Seven `PASS` rows prove only these inspected local prerequisites. They do not prove spec semantics, test execution, browser launchability, host-library compatibility, Shopify reachability, authenticated-session validity, or live-store health. Profile readiness remains owned by `shopify-e2e auth list`.

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

## Capture, refresh, remove, and inspect profiles

Run the interactive auth menu:

```sh
shopify-e2e auth
```

It offers capture, refresh, remove, list, and cancel. Direct equivalents are:

```sh
shopify-e2e auth capture
shopify-e2e auth capture --role customer --profile customer-primary
shopify-e2e auth refresh
shopify-e2e auth refresh --profile customer-primary
shopify-e2e auth remove
shopify-e2e auth remove --profile customer-primary
shopify-e2e auth remove --profile customer-primary --yes
shopify-e2e auth list
```

The complete auth surface is `auth [--config <path>]`, `auth capture [--config <path>] [--role <role>] [--profile <name>]`, `auth refresh [--config <path>] [--profile <name>]`, `auth remove [--config <path>] [--profile <name>] [--yes]`, and `auth list [--config <path>]`. These commands accept no positional arguments.

Capture and refresh require an interactive terminal. Missing role/profile values are prompted; supplied values are validated without prompting. `auth list` works non-interactively and never loads Playwright.

Capture opens a fresh, headed, non-persistent consumer-owned Chromium context. Enter storefront passwords, Shopify credentials, and one-time codes only in that browser window. The CLI never asks for credentials and never tries to detect when login is complete. Return to the terminal and explicitly confirm when the browser state should be saved.

Refresh starts another fresh context using only the selected profile's prior state and atomically replaces that state after confirmation. Declining, closing the browser, or cancelling leaves the previous profile unchanged.

Removal is scoped to the normalized `SHOPIFY_STORE_URL` origin currently configured. It never searches or changes another origin partition and does not require Playwright or a browser. The prompt/flag behavior is:

| Invocation | Interactive terminal | Non-interactive terminal |
|---|---|---|
| `auth remove` | Select a profile, then confirm; confirmation defaults to no | Exit `2`; no change |
| `auth remove --profile <name>` | Confirm the named profile; confirmation defaults to no | Exit `2`; no change |
| `auth remove --yes` | Select a profile, then remove it without confirmation | Exit `2`; no change |
| `auth remove --profile <name> --yes` | Remove without prompts | Remove without prompts |

Removal candidates are real, path-safe profile directories in the current origin, including profiles whose metadata or state is corrupt. Unknown names, unsafe names, symlinks, non-directories, hidden temporary entries, and synthetic unauthenticated role names are refused with exit `2`. A physical directory whose name collides with a synthetic role is intentionally not CLI-removable; inspect and clean that collision manually.

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

Do not commit or log profile state, `.env`, screenshots, traces, or browser output. If a profile may be compromised, revoke or rotate the represented access where possible as well as removing the local copy.

Removal first renames the active profile into a hidden same-partition `.tmp-remove-*` quarantine, then recursively deletes that quarantine. Before the rename commits, failure leaves the active profile unchanged. After the rename, the profile remains unavailable even if cleanup fails; the CLI exits `1` and reports that local secret cleanup is incomplete. Successful removal keeps the origin partition and all sibling profiles in place.

Automatic stale-quarantine cleanup is not provided. For manual cleanup, locate the profile data root as the exact absolute `SHOPIFY_E2E_DATA_DIR` value when that override is set; otherwise use oclif's platform application-data directory for dirname `shopify-e2e` (the operating system's application-data location, never the consuming repository). Under that root, inspect only the affected `origins/<origin-hash>/profiles/.tmp-remove-*` entries. Stop CLI processes first, preserve the origin and sibling directories, and remove only quarantines you have identified. Using a known absolute `SHOPIFY_E2E_DATA_DIR` before capture makes this recovery location unambiguous across platforms.

Filesystem deletion is not secure erasure or crash-durable sanitization. Data or access can survive in snapshots, backups, open file handles, storage media, a retained or partially deleted quarantine, or a still-live remote Shopify session. Revoke or rotate the represented access where possible when cleanup is incomplete or compromise is suspected.

The boundary protects against accidental commits, cross-origin/profile mixups, partial replacement, and unrelated out-of-root test loading. It does not protect against malicious consumer config/spec code, a compromised Playwright/browser dependency, concurrent writers, or another process running as the same OS user.

## Exit behavior

- `0`: success or a user cancellation with no mutation. For `doctor`, all seven checks passed. For removal, this includes declining the default-no confirmation; a signal after the removal rename also exits `0` if quarantine cleanup completes.
- `1`: package/browser/filesystem infrastructure failure, Playwright's own test/no-test failure, or an unexpected `doctor` inspection error. A removal failure before rename leaves the active profile unchanged; a cleanup failure after rename leaves it unavailable and means local secret cleanup is incomplete.
- `2`: usage, config, URL, profile, TTY, boundary, or peer preflight refusal. For `doctor`, at least one expected readiness check failed and no check errored. Removal refusals do not mutate the registry.
- `130`: terminal Ctrl+C or `SIGINT` before a removal commits, after cleanup of temporary work; for `doctor`, interruption before a complete report.
- `143`: `SIGTERM` before a removal commits, after cleanup of temporary work; for `doctor`, interruption before a complete report.
- Other numeric Playwright child exits pass through unchanged.

## Verification

```sh
npm run test:installed
npm run verify
```

These deterministic gates are browserless and do not contact Shopify or a storefront. The installed doctor proof uses a controlled consumer peer and a regular fake Chromium file whose `launch` method fails and leaves a sentinel if called. Packed consumer installation may use the configured npm registry or cache, with Playwright browser download disabled. No CI workflow is part of this phase.

The optional local Chromium isolation probe is separate:

```sh
npm run test:browser:profiles
```

It installs the packed CLI into a temporary consumer and uses only a loopback HTTP origin to prove A-B-guest-A cookie, localStorage, and IndexedDB isolation. It does not weaken the production HTTPS URL requirement.

The [Levelogy manual consumer](tests/fixtures/storefront-smoke-consumer/README.md) covers the password-protected Shopify acceptance flow and is intentionally excluded from deterministic verification.
