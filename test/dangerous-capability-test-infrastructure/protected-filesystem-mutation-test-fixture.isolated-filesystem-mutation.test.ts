import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createProtectedFilesystemMutationTestFixture } from "./protected-filesystem-mutation-test-fixture";

describe("protected filesystem mutation test fixture", () => {
	it("allows deletion of an owned target while preserving protected sibling and symlink-target canaries", () => {
		const fixture = createProtectedFilesystemMutationTestFixture();
		const ownedDeletionTargetDirectoryPath = fixture.createOwnedMutationDirectory({
			ownedDirectoryName: "owned-deletion-target",
		});
		const symlinkEscapeCandidatePath = fixture.createSymlinkEscapeCandidate({
			symlinkName: "symlink-escape-candidate",
		});

		rmSync(ownedDeletionTargetDirectoryPath, { recursive: true });
		rmSync(symlinkEscapeCandidatePath);

		expect(() => fixture.assertProtectedCanariesIntact()).not.toThrow();
	});

	it("rejects owned mutation directory names that can escape the sandbox", () => {
		const fixture = createProtectedFilesystemMutationTestFixture();

		expect(() =>
			fixture.createOwnedMutationDirectory({ ownedDirectoryName: "../outside-owned-mutation-sandbox" }),
		).toThrow(/one non-empty directory name/);
	});

	it("sandbox root identity 被替换时拒绝 cleanup 并保留原现场", () => {
		const fixture = createProtectedFilesystemMutationTestFixture();
		const originalFixtureRootDirectoryPath = fixture.fixtureRootDirectoryPath;
		const movedOriginalFixtureRootDirectoryPath = `${originalFixtureRootDirectoryPath}-moved-original`;
		renameSync(originalFixtureRootDirectoryPath, movedOriginalFixtureRootDirectoryPath);
		mkdirSync(originalFixtureRootDirectoryPath);

		expect(() => fixture.cleanup()).toThrow(/Fixture root filesystem identity changed/);
		expect(existsSync(movedOriginalFixtureRootDirectoryPath)).toBe(true);

		rmSync(originalFixtureRootDirectoryPath, { recursive: true });
		renameSync(movedOriginalFixtureRootDirectoryPath, originalFixtureRootDirectoryPath);
		fixture.cleanup();
	});
});
