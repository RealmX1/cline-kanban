import { randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureVerificationAssetsDir } from "../../../src/deployment/verification-assets";
import {
	readVerificationExecutionAttempt,
	verificationExecutionAttemptDirectory,
} from "../../../src/deployment/verification-execution-attempt-store";
import { runVerificationScript } from "../../../src/deployment/verification-script-runner";
import { waitForConditionWithinLoadSensitiveTwoTierDeadline } from "../../utilities/load-sensitive-wall-clock-two-tier-deadline";
import { createTempDir } from "../../utilities/temp-dir";
import { cleanupIsolatedVerificationExecutionAttempts } from "./verification-execution-isolated-runtime-fixture";

// Linux 必须实际编译并建立内核边界；缺少能力应失败，不能把测试跳成“退出未知”。
describe.skipIf(process.platform !== "linux")("Linux 独立执行的内核后代边界", { timeout: 120_000 }, () => {
	let sandbox: ReturnType<typeof createTempDir>;
	beforeEach(() => {
		sandbox = createTempDir("verification-linux-kernel-containment-");
		for (const key of ["HOME", "USERPROFILE", "CODEX_HOME", "CODEX_SQLITE_HOME"]) vi.stubEnv(key, sandbox.path);
	});
	afterEach(async () => {
		await cleanupIsolatedVerificationExecutionAttempts();
		vi.unstubAllEnvs();
		sandbox.cleanup();
	});
	async function prepareScript(body: string) {
		const verificationId = randomUUID();
		const directory = await ensureVerificationAssetsDir(verificationId);
		await writeFile(join(directory, "run.cjs"), body);
		return () =>
			runVerificationScript({
				verificationId,
				script: { entrypoint: "run.cjs", interpreter: "node", timeoutMs: 60_000 },
				startedAtIso: new Date().toISOString(),
				finishedAtIsoProvider: () => new Date().toISOString(),
			});
	}
	it("A 仍运行且在 B baseline 后派生后代，B 独立 passed，A 与后代不受影响", async (context) => {
		const trigger = join(sandbox.path, "allow-a-late-child");
		const releaseA = join(sandbox.path, "release-a");
		const readyA = join(sandbox.path, "a-ready");
		const writes = join(sandbox.path, "a-child-writes");
		const releaseB = join(sandbox.path, "release-b");
		const readyB = join(sandbox.path, "b-ready");
		async function waitForFile(path: string) {
			await waitForConditionWithinLoadSensitiveTwoTierDeadline(
				context,
				{
					waitedForDescription: `隔离执行屏障 ${path}`,
					softDeadlineMsExpectedOnUncontendedHost: 5000,
					hardDeadlineMsOnlyExplainedByRealHangOrRegression: 30_000,
				},
				async () => {
					try {
						await access(path);
						return true;
					} catch {
						return false;
					}
				},
			);
		}
		const childBody = `const fs=require('node:fs');const timer=setInterval(()=>{fs.appendFileSync(${JSON.stringify(writes)},'x');if(fs.existsSync(${JSON.stringify(releaseA)})){clearInterval(timer);}},20);`;
		const runA = await prepareScript(
			`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(readyA)},'ready');let launched=false;const timer=setInterval(()=>{if(!launched&&fs.existsSync(${JSON.stringify(trigger)})){launched=true;require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childBody)}],{detached:true,stdio:'ignore'}).unref();}if(fs.existsSync(${JSON.stringify(releaseA)}))clearInterval(timer);},20);`,
		);
		const runB = await prepareScript(
			`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(readyB)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseB)}))clearInterval(timer);},20);`,
		);
		const pendingA = runA();
		let settledA = false;
		void pendingA.then(() => {
			settledA = true;
		});
		await waitForFile(readyA);
		const pendingB = runB();
		await waitForFile(readyB);
		await writeFile(trigger, "go");
		await waitForFile(writes);
		await writeFile(releaseB, "go");
		const resultB = await pendingB;
		expect(resultB.status).toBe("passed");
		expect(resultB.exitCode).toBe(0);
		expect(settledA).toBe(false);
		const before = await readFile(writes, "utf8");
		await delay(120);
		expect((await readFile(writes, "utf8")).length).toBeGreaterThan(before.length);
		const attemptB = await readVerificationExecutionAttempt(resultB.verificationExecutionAttemptId ?? "");
		const progressB = JSON.parse(
			await readFile(
				join(
					verificationExecutionAttemptDirectory(attemptB.verificationExecutionAttemptId),
					`supervisor-progress-${attemptB.verificationExecutionAttemptId}.json`,
				),
				"utf8",
			),
		);
		expect(progressB.linuxKernelContainmentVerified).toBe(true);
		expect(progressB.kernelChildExitObservation).toBe(0);
		await writeFile(releaseA, "go");
		expect((await pendingA).status).toBe("passed");
	});
	it("快速双 fork / setsid 并清空环境后仍被收养，超时杀树并取得 ECHILD", async (context) => {
		const verificationId = randomUUID();
		const directory = await ensureVerificationAssetsDir(verificationId);
		const writes = join(sandbox.path, "escaped-descendant-writes");
		const childPid = join(sandbox.path, "escaped-descendant-pid");
		const descendant = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(childPid)},String(process.pid));setInterval(()=>fs.appendFileSync(${JSON.stringify(writes)},'x'),20);`;
		const middle = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore',env:{}}).unref();`;
		await writeFile(
			join(directory, "run.cjs"),
			`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(middle)}],{detached:true,stdio:'ignore',env:{}}).unref();`,
		);
		const pending = runVerificationScript({
			verificationId,
			script: { entrypoint: "run.cjs", interpreter: "node", timeoutMs: 5000 },
			startedAtIso: new Date().toISOString(),
			finishedAtIsoProvider: () => new Date().toISOString(),
		});
		await waitForConditionWithinLoadSensitiveTwoTierDeadline(
			context,
			{
				waitedForDescription: "清空环境的脱组后代已经开始写入",
				softDeadlineMsExpectedOnUncontendedHost: 2000,
				hardDeadlineMsOnlyExplainedByRealHangOrRegression: 20_000,
			},
			async () => {
				try {
					await access(writes);
					return true;
				} catch {
					return false;
				}
			},
		);
		const outcome = await pending;
		expect(outcome.status).toBe("timed_out");
		const before = await readFile(writes, "utf8");
		await delay(200);
		expect(await readFile(writes, "utf8")).toBe(before);
		const id = outcome.verificationExecutionAttemptId ?? "";
		const progress = JSON.parse(
			await readFile(join(verificationExecutionAttemptDirectory(id), `supervisor-progress-${id}.json`), "utf8"),
		);
		expect(progress.linuxKernelContainmentVerified).toBe(true);
		expect(progress.kernelChildExitObservation).toBe(0);
		const escapedPid = Number(await readFile(childPid, "utf8"));
		expect(progress.ownedProcesses.some((entry: { pid: number }) => entry.pid === escapedPid)).toBe(true);
	});
});
