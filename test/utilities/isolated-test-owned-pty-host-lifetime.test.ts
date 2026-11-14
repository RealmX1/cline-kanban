import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	readTestOwnedProcessGeneration,
	reclaimTestOwnedPtyHostLifetime,
	TEST_PTY_LIFETIME_LEASE_PATH_ENVIRONMENT_VARIABLE,
} from "./isolated-test-owned-pty-host-lifetime";

vi.mock("node:child_process", { spy: true });

afterEach(() => vi.restoreAllMocks());

describe.skipIf(process.platform === "win32")("测试 PTY 持久所有权门禁", () => {
	function createSyntheticEndedLifetime() {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const environment = fixture.createIsolatedChildProcessEnvironment();
		const leasePath = environment[TEST_PTY_LIFETIME_LEASE_PATH_ENVIRONMENT_VARIABLE];
		if (!leasePath) throw new Error("测试 fixture 无 lease");
		const lease = JSON.parse(readFileSync(leasePath, "utf8")) as { nonce: string; closed: boolean };
		lease.closed = true;
		writeFileSync(leasePath, JSON.stringify(lease));
		const recordPath = join(dirname(leasePath), "host-synthetic-generation.json");
		const mismatchedGeneration = { pid: process.pid, startedAt: "unrelated-process-generation" };
		const record = {
			leaseNonce: lease.nonce,
			process: mismatchedGeneration,
			socketPath: join(fixture.fixtureRootDirectoryPath, "absent-host.sock"),
			hostBuildIdentity: "test-build",
			hostProcessInstanceId: null,
			socketIdentity: null,
			observedProcesses: [mismatchedGeneration],
			outcome: "pending",
		};
		writeFileSync(recordPath, JSON.stringify(record));
		return { leasePath, recordPath, record };
	}

	it("PID 被新世代复用时不发送信号，旧世代完成回收可重复核验", async () => {
		const { leasePath, recordPath } = createSyntheticEndedLifetime();
		const signalSpy = vi.spyOn(process, "kill");
		expect(await reclaimTestOwnedPtyHostLifetime(leasePath)).toBe(true);
		expect(await reclaimTestOwnedPtyHostLifetime(leasePath)).toBe(true);
		expect(JSON.parse(readFileSync(recordPath, "utf8")).outcome).toBe("completed");
		expect(signalSpy).not.toHaveBeenCalled();
		expect(readTestOwnedProcessGeneration(process.pid)?.pid).toBe(process.pid);
	});

	it("nonce 不匹配拒绝回收，恢复原始归属后可自动补证", async () => {
		const { leasePath, recordPath, record } = createSyntheticEndedLifetime();
		writeFileSync(recordPath, JSON.stringify({ ...record, leaseNonce: randomUUID() }));
		await expect(reclaimTestOwnedPtyHostLifetime(leasePath)).rejects.toThrow(/归属 nonce 不符/);
		expect(JSON.parse(readFileSync(recordPath, "utf8")).outcome).toBe("pending");
		writeFileSync(recordPath, JSON.stringify(record));
		expect(await reclaimTestOwnedPtyHostLifetime(leasePath)).toBe(true);
	});

	it("原生观测失败保留缺证，下一次可用观测恢复，不冒充已退出", async () => {
		const { leasePath, recordPath } = createSyntheticEndedLifetime();
		const failedObservation = vi.mocked(childProcess.spawnSync).mockImplementationOnce(() => {
			throw new Error("模拟 ps 观测故障");
		});
		await expect(reclaimTestOwnedPtyHostLifetime(leasePath)).rejects.toThrow(/观测故障/);
		expect(JSON.parse(readFileSync(recordPath, "utf8")).outcome).toBe("pending");
		failedObservation.mockRestore();
		expect(await reclaimTestOwnedPtyHostLifetime(leasePath)).toBe(true);
		const audit = readFileSync(join(dirname(leasePath), "reclamation-attempts.jsonl"), "utf8");
		expect(audit).toContain("controller_generation_unknown");
		expect(audit).toContain('"outcome":"completed"');
	});
});
