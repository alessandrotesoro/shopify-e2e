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

	it("keeps verification unprivileged and publishes one verified artifact", async () => {
		const workflow = await readFile(workflowPath, "utf8");
		const verifyJob = workflow.split("\n  publish:", 1)[0];
		const publishJob = workflow.slice(workflow.indexOf("\n  publish:"));

		expect(verifyJob).toContain("contents: read");
		expect(verifyJob).not.toContain("id-token: write");
		expect(publishJob).toContain("id-token: write");
		expect(workflow).toContain("actions/checkout@v7");
		expect(workflow).toContain("actions/setup-node@v6");
		expect(workflow).toContain("node-version: 24.x");
		expect(workflow).toContain("package-manager-cache: false");
		expect(workflow).toContain("npm ci");
		expect(workflow).toContain("npm pack --dry-run --json");
		expect(workflow).toContain("actions/upload-artifact@v4");
		expect(workflow).toContain("actions/download-artifact@v4");
		expect(publishJob).not.toContain("NPM_TOKEN");
		expect(publishJob).toContain(
			"npm publish publish-artifact/package.tgz --access public --provenance --ignore-scripts",
		);
		expect(publishJob.match(/npm publish\b/g)).toHaveLength(1);
		expect(workflow).not.toMatch(/npm_[A-Za-z0-9]{20,}/);
	});

	it("requires exact public registry and provenance read-back", async () => {
		const workflow = await readFile(workflowPath, "utf8");

		expect(workflow).toContain("NPM_CONFIG_USERCONFIG");
		expect(workflow).toContain("dist-tags.latest");
		expect(workflow).toContain("dist?.attestations?.provenance?.predicateType");
		expect(workflow).toContain("metadata.dist.integrity");
	});
});
