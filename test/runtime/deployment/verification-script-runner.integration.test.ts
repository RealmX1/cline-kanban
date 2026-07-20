import { randomUUID } from "node:crypto";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureVerificationAssetsDir } from "../../../src/deployment/verification-assets";
import { runVerificationScript } from "../../../src/deployment/verification-script-runner";
import { createTempDir } from "../../utilities/temp-dir";

describe.sequential("verification-script-runner", () => {
	let sandbox: ReturnType<typeof createTempDir>;
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;

	beforeEach(() => {
		sandbox = createTempDir("kanban-verification-runner-");
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

	const FIXED_START = "2026-06-01T00:00:00.000Z";
	const FIXED_FINISH = "2026-06-01T00:00:01.000Z";

	async function writeScript(verificationId: string, filename: string, contents: string): Promise<void> {
		const dir = await ensureVerificationAssetsDir(verificationId);
		writeFileSync(join(dir, filename), contents, "utf8");
	}

	it("exit 0 → passed，捕获 stdout，注入 KANBAN_VERIFICATION_ID", async () => {
		const verificationId = randomUUID();
		await writeScript(verificationId, "run.sh", 'echo "hello from $KANBAN_VERIFICATION_ID"\nexit 0\n');

		const outcome = await runVerificationScript({
			verificationId,
			script: { entrypoint: "run.sh", interpreter: "bash", timeoutMs: 10000 },
			startedAtIso: FIXED_START,
			finishedAtIsoProvider: () => FIXED_FINISH,
		});

		expect(outcome.status).toBe("passed");
		expect(outcome.exitCode).toBe(0);
		expect(outcome.outputExcerpt).toContain(verificationId);
		expect(outcome.startedAtIso).toBe(FIXED_START);
		expect(outcome.finishedAtIso).toBe(FIXED_FINISH);
	});

	it("exit 非 0 → failed，捕获 stderr", async () => {
		const verificationId = randomUUID();
		await writeScript(verificationId, "run.sh", 'echo "boom" 1>&2\nexit 3\n');

		const outcome = await runVerificationScript({
			verificationId,
			script: { entrypoint: "run.sh", interpreter: "bash", timeoutMs: 10000 },
			startedAtIso: FIXED_START,
			finishedAtIsoProvider: () => FIXED_FINISH,
		});

		expect(outcome.status).toBe("failed");
		expect(outcome.exitCode).toBe(3);
		expect(outcome.outputExcerpt).toContain("boom");
	});

	it("超过 timeout → timed_out", async () => {
		const verificationId = randomUUID();
		await writeScript(verificationId, "run.sh", "sleep 5\n");

		const outcome = await runVerificationScript({
			verificationId,
			script: { entrypoint: "run.sh", interpreter: "bash", timeoutMs: 150 },
			startedAtIso: FIXED_START,
			finishedAtIsoProvider: () => FIXED_FINISH,
		});

		expect(outcome.status).toBe("timed_out");
	});

	it("node 解释器运行 .js 入口", async () => {
		const verificationId = randomUUID();
		await writeScript(verificationId, "run.js", 'console.log("from node"); process.exit(0);\n');

		const outcome = await runVerificationScript({
			verificationId,
			script: { entrypoint: "run.js", interpreter: "node", timeoutMs: 10000 },
			startedAtIso: FIXED_START,
			finishedAtIsoProvider: () => FIXED_FINISH,
		});

		expect(outcome.status).toBe("passed");
		expect(outcome.outputExcerpt).toContain("from node");
	});

	it("entrypoint 相对路径逃逸（../）→ errored 且不执行脚本", async () => {
		const verificationId = randomUUID();
		// 确保资产目录存在（护栏在其后按 realpath 判定），并在资产目录之外放一个会留痕的脚本。
		const assetsDir = await ensureVerificationAssetsDir(verificationId);
		const escapeMarkerPath = join(sandbox.path, "escape-executed.marker");
		writeFileSync(join(assetsDir, "..", "outside.sh"), `touch "${escapeMarkerPath}"\nexit 0\n`, "utf8");

		const outcome = await runVerificationScript({
			verificationId,
			script: { entrypoint: "../outside.sh", interpreter: "bash", timeoutMs: 10000 },
			startedAtIso: FIXED_START,
			finishedAtIsoProvider: () => FIXED_FINISH,
		});

		expect(outcome.status).toBe("errored");
		expect(outcome.exitCode).toBeNull();
		expect(outcome.outputExcerpt).toContain("entrypoint 校验失败");
		expect(existsSync(escapeMarkerPath)).toBe(false);
	});

	it("entrypoint 绝对路径 → errored 且不执行脚本", async () => {
		const verificationId = randomUUID();
		await ensureVerificationAssetsDir(verificationId);
		const absoluteScriptPath = join(sandbox.path, "absolute-outside.sh");
		const escapeMarkerPath = join(sandbox.path, "absolute-executed.marker");
		writeFileSync(absoluteScriptPath, `touch "${escapeMarkerPath}"\nexit 0\n`, "utf8");

		const outcome = await runVerificationScript({
			verificationId,
			script: { entrypoint: absoluteScriptPath, interpreter: "bash", timeoutMs: 10000 },
			startedAtIso: FIXED_START,
			finishedAtIsoProvider: () => FIXED_FINISH,
		});

		expect(outcome.status).toBe("errored");
		expect(outcome.outputExcerpt).toContain("不允许绝对路径");
		expect(existsSync(escapeMarkerPath)).toBe(false);
	});

	it("entrypoint 为指向资产目录外的 symlink → errored 且不执行脚本", async () => {
		const verificationId = randomUUID();
		const assetsDir = await ensureVerificationAssetsDir(verificationId);
		const outsideScriptPath = join(sandbox.path, "symlink-target-outside.sh");
		const escapeMarkerPath = join(sandbox.path, "symlink-executed.marker");
		writeFileSync(outsideScriptPath, `touch "${escapeMarkerPath}"\nexit 0\n`, "utf8");
		symlinkSync(outsideScriptPath, join(assetsDir, "run.sh"));

		const outcome = await runVerificationScript({
			verificationId,
			script: { entrypoint: "run.sh", interpreter: "bash", timeoutMs: 10000 },
			startedAtIso: FIXED_START,
			finishedAtIsoProvider: () => FIXED_FINISH,
		});

		expect(outcome.status).toBe("errored");
		expect(outcome.outputExcerpt).toContain("越界");
		expect(existsSync(escapeMarkerPath)).toBe(false);
	});

	it("高输出脚本：运行期缓冲被裁剪，摘录仍保留尾部且总长有界", async () => {
		const verificationId = randomUUID();
		// 输出远超运行期缓冲上限（2×4000），末尾输出一个可断言的哨兵行。
		await writeScript(
			verificationId,
			"run.sh",
			'for i in $(seq 1 2000); do echo "line-$i-padding-padding-padding-padding"; done\necho "FINAL-TAIL-SENTINEL"\nexit 0\n',
		);

		const outcome = await runVerificationScript({
			verificationId,
			script: { entrypoint: "run.sh", interpreter: "bash", timeoutMs: 20000 },
			startedAtIso: FIXED_START,
			finishedAtIsoProvider: () => FIXED_FINISH,
		});

		expect(outcome.status).toBe("passed");
		expect(outcome.outputExcerpt).toContain("已截断");
		expect(outcome.outputExcerpt).toContain("FINAL-TAIL-SENTINEL");
		// 摘录 = 截断标记行 + 尾部 4000 字符，总长必然远小于原始输出。
		expect(outcome.outputExcerpt.length).toBeLessThan(4200);
	});
});
