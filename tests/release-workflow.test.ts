import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const workflowPath = resolve(
	import.meta.dirname,
	"../.github/workflows/publish-npm.yml",
);

describe("npm release workflow", () => {
	it("publishes only from a published stable GitHub Release", async () => {
		const workflow = await readFile(workflowPath, "utf8");

		expect(workflow).toMatch(/on:\s*\n\s+release:\s*\n\s+types: \[published\]/);
		expect(workflow).toContain("workflow_dispatch:");
		expect(workflow).toContain(
			"description: Release tag to publish after a failed release-event run",
		);
		expect(workflow).not.toMatch(/\n\s+push:/);
		expect(workflow).toContain("RELEASE_PRERELEASE");
		expect(workflow).toContain('test "$RELEASE_PRERELEASE" = "false"');
		expect(workflow).toContain("RELEASE_ACTOR: ${{ " + "github.actor }}");
		expect(workflow).toContain('test "$RELEASE_ACTOR" = "$EXPECTED_OWNER"');
		expect(workflow).toContain('test "$RELEASE_AUTHOR" = "$EXPECTED_OWNER"');
		expect(workflow).toContain('test "$RELEASE_TAG" = "v$EXPECTED_VERSION"');
		expect(workflow).toContain(
			'test "$(git cat-file -t "refs/tags/$RELEASE_TAG")" = "tag"',
		);
	});

	it("uses the account's simple OIDC publishing pattern", async () => {
		const workflow = await readFile(workflowPath, "utf8");

		expect(workflow).toContain("contents: read");
		expect(workflow).toContain("id-token: write");
		expect(workflow).toContain("actions/checkout@v7");
		expect(workflow).toContain("actions/setup-node@v6");
		expect(workflow).toContain("node-version: 24.x");
		expect(workflow).toContain("package-manager-cache: false");
		expect(workflow).toContain("npm ci");
		expect(workflow).toContain("npm pack --dry-run --json");
		expect(workflow).not.toContain("NPM_TOKEN");
		expect(workflow).toContain(
			"npm publish --access public --provenance --ignore-scripts",
		);
		expect(workflow.match(/npm publish\b/g)).toHaveLength(1);
		expect(workflow).not.toMatch(/npm_[A-Za-z0-9]{20,}/);
	});

	it("checks the public npm version after publishing with provenance", async () => {
		const workflow = await readFile(workflowPath, "utf8");

		expect(workflow).toContain("npm view \"$EXPECTED_PACKAGE@$EXPECTED_VERSION\" version");
		expect(workflow).toContain("--provenance");
	});
});
