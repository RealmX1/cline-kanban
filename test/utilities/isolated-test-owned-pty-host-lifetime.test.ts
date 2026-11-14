import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import {
	createIsolatedTestOwnedPtyHostLifetime,
	readTestOwnedProcessGeneration,
	reclaimTestOwnedPtyHostLifetime,
	recoverAbandonedTestPtyHostLifetimes,
	TEST_PTY_LIFETIME_LEASE_PATH_ENVIRONMENT_VARIABLE,
	TEST_PTY_LIFETIME_RECORDS_DIRECTORY_ENVIRONMENT_VARIABLE,
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

	function useIsolatedLifetimeRecords(): string {
		const recordsDirectory = mkdtempSync(join(tmpdir(), "pty-lifetime-index-"));
		vi.stubEnv(TEST_PTY_LIFETIME_RECORDS_DIRECTORY_ENVIRONMENT_VARIABLE, recordsDirectory);
		return recordsDirectory;
	}

	function writeLeaseThatFailsIfParsed(recordsDirectory: string, mentionedPath: string): void {
		mkdirSync(recordsDirectory, { recursive: true });
		const lifetimeDirectory = mkdtempSync(join(recordsDirectory, "fixture-lifetime-"));
		writeFileSync(join(lifetimeDirectory, "fixture-owner-lease.json"), `${mentionedPath}\n{`);
	}

	function indexedLifetimeMarkers(recordsDirectory: string): string[] {
		const indexRoot = join(recordsDirectory, "fixture-root-index");
		if (!existsSync(indexRoot)) return [];
		return readdirSync(indexRoot).flatMap((hashName) => readdirSync(join(indexRoot, hashName)));
	}

	function releaseIsolatedLifetimeRecords(recordsDirectory: string): void {
		vi.unstubAllEnvs();
		rmSync(recordsDirectory, { recursive: true, force: true });
	}

	it("普通 fixture 清理不解析无关历史 lease", () => {
		const recordsDirectory = useIsolatedLifetimeRecords();
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const otherLifetime = createIsolatedTestOwnedPtyHostLifetime(join(recordsDirectory, "other-fixture-root"));
		try {
			writeLeaseThatFailsIfParsed(recordsDirectory, fixture.fixtureRootDirectoryPath);
			writeLeaseThatFailsIfParsed(recordsDirectory, fixture.fixtureRootDirectoryPath);
			const otherLeasePath = otherLifetime.environmentVariables[TEST_PTY_LIFETIME_LEASE_PATH_ENVIRONMENT_VARIABLE];
			if (!otherLeasePath) throw new Error("其他 fixture 无 lease");
			writeFileSync(otherLeasePath, `${fixture.fixtureRootDirectoryPath}\n{`);
			expect(indexedLifetimeMarkers(recordsDirectory)).not.toEqual([]);
			fixture.cleanup();
			expect(existsSync(fixture.fixtureRootDirectoryPath)).toBe(false);
		} finally {
			otherLifetime.closeAndVerifyOwnedHostExit();
			fixture.cleanup();
			releaseIsolatedLifetimeRecords(recordsDirectory);
		}
	});

	it("本进程登记的 lifetime 不阻止清理，关闭后移除索引", () => {
		const recordsDirectory = useIsolatedLifetimeRecords();
		const fixture = createIsolatedGitTestWorkspaceFixture();
		try {
			fixture.createIsolatedChildProcessEnvironment();
			writeLeaseThatFailsIfParsed(recordsDirectory, fixture.fixtureRootDirectoryPath);
			expect(indexedLifetimeMarkers(recordsDirectory)).toHaveLength(1);
			fixture.cleanup();
			expect(existsSync(fixture.fixtureRootDirectoryPath)).toBe(false);
			expect(indexedLifetimeMarkers(recordsDirectory)).toEqual([]);
		} finally {
			fixture.cleanup();
			releaseIsolatedLifetimeRecords(recordsDirectory);
		}
	});

	it("本 fixture 索引里的存活 owner 拒绝删除", () => {
		const recordsDirectory = useIsolatedLifetimeRecords();
		const fixture = createIsolatedGitTestWorkspaceFixture();
		const lifetime = createIsolatedTestOwnedPtyHostLifetime(fixture.fixtureRootDirectoryPath);
		const otherLifetime = createIsolatedTestOwnedPtyHostLifetime(join(recordsDirectory, "other-fixture-root"));
		try {
			const leasePath = lifetime.environmentVariables[TEST_PTY_LIFETIME_LEASE_PATH_ENVIRONMENT_VARIABLE];
			const otherLeasePath = otherLifetime.environmentVariables[TEST_PTY_LIFETIME_LEASE_PATH_ENVIRONMENT_VARIABLE];
			if (!leasePath || !otherLeasePath) throw new Error("存活 owner 夹具不完整");
			const generation = readTestOwnedProcessGeneration(process.ppid);
			if (!generation || generation.pid === process.pid) throw new Error("找不到另一个仍存活的 owner 世代");
			const lease = JSON.parse(readFileSync(leasePath, "utf8")) as { owner: { pid: number; startedAt: string } };
			lease.owner = generation;
			writeFileSync(leasePath, JSON.stringify(lease));
			writeFileSync(otherLeasePath, `${fixture.fixtureRootDirectoryPath}\n{`);
			writeLeaseThatFailsIfParsed(recordsDirectory, fixture.fixtureRootDirectoryPath);
			expect(() => fixture.cleanup()).toThrow(
				`测试 fixture 仍有存活的 PTY owner ${generation.pid}，拒绝删除 ${fixture.fixtureRootDirectoryPath}`,
			);
			expect(existsSync(fixture.fixtureRootDirectoryPath)).toBe(true);
		} finally {
			lifetime.closeAndVerifyOwnedHostExit();
			otherLifetime.closeAndVerifyOwnedHostExit();
			fixture.cleanup();
			releaseIsolatedLifetimeRecords(recordsDirectory);
		}
	});

	it("没有索引的旧寿命仍由启动恢复扫描删除", async () => {
		const recordsDirectory = useIsolatedLifetimeRecords();
		const lifetimeDirectory = mkdtempSync(join(recordsDirectory, "fixture-lifetime-"));
		writeFileSync(
			join(lifetimeDirectory, "fixture-owner-lease.json"),
			JSON.stringify({
				nonce: randomUUID(),
				fixtureRootDirectoryPath: join(recordsDirectory, "already-removed-fixture"),
				owner: { pid: 2_147_483_646, startedAt: "dead-generation" },
				ownerSocketPath: join(recordsDirectory, "absent-owner.sock"),
				ownerSocketIdentity: null,
				closed: false,
				synchronousCleanupInProgress: false,
			}),
		);
		try {
			await recoverAbandonedTestPtyHostLifetimes(recordsDirectory);
			expect(existsSync(lifetimeDirectory)).toBe(false);
		} finally {
			releaseIsolatedLifetimeRecords(recordsDirectory);
		}
	});
});
