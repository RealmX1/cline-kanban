import { randomUUID } from "node:crypto";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	cleanupVerificationAssets,
	ensureVerificationAssetsDir,
	getVerificationAssetsRoot,
} from "../../../src/deployment/verification-assets";
import {
	createProtectedFilesystemMutationTestFixture,
	type ProtectedFilesystemMutationTestFixture,
} from "../../dangerous-capability-test-infrastructure/protected-filesystem-mutation-test-fixture";

describe.sequential("cleanupVerificationAssets 护栏", () => {
	let filesystemFixture: ProtectedFilesystemMutationTestFixture;
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;

	beforeEach(() => {
		filesystemFixture = createProtectedFilesystemMutationTestFixture();
		const isolatedHomeDirectoryPath = filesystemFixture.createOwnedMutationDirectory({
			ownedDirectoryName: "verification-assets-cleanup-home",
		});
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = isolatedHomeDirectoryPath;
		process.env.USERPROFILE = isolatedHomeDirectoryPath;
	});

	afterEach(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		filesystemFixture.assertProtectedCanariesIntact();
		filesystemFixture.cleanup();
	});

	it("删除 verifications 根下的资产目录", async () => {
		const verificationId = randomUUID();
		const dir = await ensureVerificationAssetsDir(verificationId);
		writeFileSync(join(dir, "run.sh"), "exit 0\n", "utf8");
		expect(existsSync(dir)).toBe(true);

		const result = await cleanupVerificationAssets(verificationId);

		expect(result.removed).toBe(true);
		expect(existsSync(dir)).toBe(false);
	});

	it("根存在但子目录不存在时幂等成功（already-absent）", async () => {
		// 先建根（放一个无关资产目录），再清理一个未创建的 verificationId。
		await ensureVerificationAssetsDir(randomUUID());
		const result = await cleanupVerificationAssets(randomUUID());
		expect(result.removed).toBe(false);
		expect(result.skippedReason).toBe("already-absent");
	});

	it("根都不存在时幂等成功（assets-root-missing）", async () => {
		const result = await cleanupVerificationAssets(randomUUID());
		expect(result.removed).toBe(false);
		expect(result.skippedReason).toBe("assets-root-missing");
	});

	it("symlink 逃逸到根目录外时拒删（out-of-bounds），且外部目标不被删除", async () => {
		// 在 verifications 根外造一个「机密」目录，再用一个 verificationId 目录 symlink 指向它。
		const outsideDir = filesystemFixture.protectedSiblingDirectoryPath;
		writeFileSync(join(outsideDir, "keep.txt"), "important", "utf8");

		const verificationId = randomUUID();
		// 确保 verifications 根存在（放一个无关的真实资产目录以建根）。
		await ensureVerificationAssetsDir(randomUUID());
		const escapingLink = join(getVerificationAssetsRoot(), verificationId);
		symlinkSync(outsideDir, escapingLink);

		const result = await cleanupVerificationAssets(verificationId);

		expect(result.removed).toBe(false);
		expect(result.skippedReason).toBe("out-of-bounds");
		// 越界目标必须完好无损。
		expect(existsSync(join(outsideDir, "keep.txt"))).toBe(true);
	});
});
