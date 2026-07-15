import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	ensureVerificationAssetsDir,
	getVerificationAssetsDir,
	getVerificationAssetsRoot,
} from "../../../src/deployment/verification-assets";
import { createTempDir } from "../../utilities/temp-dir";

describe.sequential("verification-assets", () => {
	let sandbox: ReturnType<typeof createTempDir>;
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;

	beforeEach(() => {
		sandbox = createTempDir("kanban-verification-assets-");
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = sandbox.path;
		process.env.USERPROFILE = sandbox.path;
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
		sandbox.cleanup();
	});

	it("assetsDir 落在 verifications 根目录下、以 verificationId 命名", () => {
		const verificationId = randomUUID();
		const dir = getVerificationAssetsDir(verificationId);
		expect(dir.startsWith(getVerificationAssetsRoot())).toBe(true);
		expect(dir.endsWith(verificationId)).toBe(true);
	});

	it("ensureVerificationAssetsDir 创建目录并返回绝对路径", async () => {
		const verificationId = randomUUID();
		expect(existsSync(getVerificationAssetsDir(verificationId))).toBe(false);
		const resolved = await ensureVerificationAssetsDir(verificationId);
		expect(existsSync(resolved)).toBe(true);
		expect(resolved).toContain(verificationId);
		// 幂等：再次调用不报错。
		await expect(ensureVerificationAssetsDir(verificationId)).resolves.toBe(resolved);
	});
});
