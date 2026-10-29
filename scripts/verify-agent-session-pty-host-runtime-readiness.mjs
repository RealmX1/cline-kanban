#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as waitForNaturalSessionExit } from "node:timers/promises";
import { assessAgentSessionPtyHostDeploymentEvidence, readLiveAgentSessionPtyHostDeploymentEvidence } from "./agent-session-pty-host-deployment-evidence.mjs";
import { collectDescendantProcessIds } from "./agent-session-pty-host-legacy-deployment-inventory.mjs";

const arguments_ = process.argv.slice(2);
const valueOf = (option) => { const index = arguments_.indexOf(option); return index < 0 ? undefined : arguments_[index + 1]; };
async function persistEvidence(output) {
	const evidenceFilePath = valueOf("--evidence-file");
	if (!evidenceFilePath) return;
	const path = resolve(evidenceFilePath);
	await mkdir(dirname(path), { recursive: true });
	const pendingPath = `${path}.pending-${process.pid}`;
	await writeFile(pendingPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
	await rename(pendingPath, path);
}

if (arguments_.includes("--self-check")) {
	const evidence = { report: { runtimeProcessId: 10, runtimeProcessStartTimeText: "runtime-start", runtimeIdentity: { runtimeHomeDirectoryPath: "/isolated", runtimePort: 3900 }, startupDecision: { disabledReason: "persistent_preference_disabled" }, newSessionHostingMode: "disabled", runtimePtySessions: [{ processId: 20, ownership: "runtime_process" }], nonPtyAgentSessionsPreventingContinuity: [], pendingHostedSessionSpawnOwnership: [], generations: [] }, processStartTimeByPid: new Map([[10, "runtime-start"]]) };
	assert.equal(assessAgentSessionPtyHostDeploymentEvidence(evidence).ok, true);
	assert.equal(assessAgentSessionPtyHostDeploymentEvidence(evidence, { requireAllSessionsPreservable: true }).ok, false);
	assert.equal(assessAgentSessionPtyHostDeploymentEvidence(evidence, { expectedRuntimeProcessId: 11 }).ok, false);
	assert.deepEqual(collectDescendantProcessIds([{ processId: 12, parentProcessId: 11 }, { processId: 11, parentProcessId: 10 }, { processId: 13, parentProcessId: 1 }], 10).sort(), [11, 12]);
	assert.equal(assessAgentSessionPtyHostDeploymentEvidence({ legacyInventory: { ok: false, failures: ["活会话"] } }).ok, false);
	process.stdout.write("部署门禁隔离自检通过；未检查或操作任何运行实例。\n");
} else {
	const expectedPidText = valueOf("--expected-runtime-process-id");
	const deadlineMs = Number(valueOf("--wait-deadline-ms") ?? "1800000");
	if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new Error("等待预算必须为正数毫秒");
	const deadlineAtEpochMs = Date.now() + deadlineMs;
	try {
		while (true) {
			let assessment;
			try {
				assessment = assessAgentSessionPtyHostDeploymentEvidence(await readLiveAgentSessionPtyHostDeploymentEvidence({ allowLegacyQuiescentStartupEvidence: arguments_.includes("--before-runtime-restart") }), { requireAllSessionsPreservable: arguments_.includes("--before-runtime-restart"), expectedRuntimeProcessId: expectedPidText ? Number(expectedPidText) : undefined });
			} catch (error) {
				assessment = { ok: false, checkedAtEpochMs: Date.now(), failures: [error instanceof Error ? error.message : String(error)], blockingSessions: [], validatedHostedSessions: [], evidenceSource: "temporarily_unavailable" };
			}
			const output = { ...assessment, candidateSourceCommit: valueOf("--candidate-source-commit") ?? null, nextCheckAtEpochMs: assessment.ok ? null : Date.now() + 30_000, recoveryCondition: assessment.ok ? null : "原 runtime 保持运行；阻塞会话自然结束或缺失证据恢复后重查" };
			await persistEvidence(output);
			process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
			if (assessment.ok) break;
			// 等待模式也自动补查机器证据缺口；只暂停停止旧 runtime 这一依赖动作。
			if (!arguments_.includes("--wait-for-natural-session-exit") || Date.now() >= deadlineAtEpochMs) { process.exitCode = 2; break; }
			await waitForNaturalSessionExit(Math.min(30_000, deadlineAtEpochMs - Date.now()));
		}
	} catch (error) {
		await persistEvidence({ ok: false, checkedAtEpochMs: Date.now(), failures: [error instanceof Error ? error.message : String(error)], recoveryCondition: "只读诊断或旧版等价盘点恢复后重查；原 runtime 保持运行" });
		process.stderr.write(`热接管状态核验未通过，保留旧 runtime：${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
