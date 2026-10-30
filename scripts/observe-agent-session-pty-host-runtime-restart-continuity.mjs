#!/usr/bin/env node
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout as waitForRuntimeObservation } from "node:timers/promises";
import { assessAgentSessionPtyHostDeploymentEvidence, compareHostedSessionContinuityAcrossRuntimeRestart, observeHostedSessionIoProgressAfterRuntimeRestart, normalizePosixProcessStartTimeText, readLiveAgentSessionPtyHostDeploymentEvidence } from "./agent-session-pty-host-deployment-evidence.mjs";

const arguments_ = process.argv.slice(2);
const valueOf = (option) => { const index = arguments_.indexOf(option); return index < 0 ? undefined : arguments_[index + 1]; };
if (arguments_.includes("--self-check")) {
	const identity = { runtimeHomeDirectoryPath: "/isolated", runtimePort: 3900 };
	const before = { checkedAtEpochMs: 100, runtimeIdentity: identity, runtimeProcessId: 10, runtimeProcessStartTimeText: "first", validatedHostedSessions: [{ workspaceId: "workspace", conversationSessionId: "session", hostedSessionKey: "unique", hostedSessionKind: "task_agent_session", processId: 20, processStartedAtEpochMs: 1, processStartTimeText: "original", runtimeSessionIncarnationId: "incarnation", nativeConversationSessionId: "native", hostProcessId: 30, hostProcessStartTimeText: "host-start", hostStartedAtEpochMs: 1, hostProcessInstanceId: "host-instance", outputEndByteOffset: 3, mostRecentPromptSubmissionId: "before", mostRecentNativePromptAcceptedAtEpochMs: 50 }] };
	const after = { ...before, runtimeProcessId: 11, runtimeProcessStartTimeText: "second", failures: [] };
	assert.deepEqual(compareHostedSessionContinuityAcrossRuntimeRestart(before, after), []);
	assert.equal(compareHostedSessionContinuityAcrossRuntimeRestart(before, { ...after, validatedHostedSessions: [{ ...before.validatedHostedSessions[0], processId: 21 }] }).length, 1);
	assert.equal(compareHostedSessionContinuityAcrossRuntimeRestart(before, { ...after, runtimeIdentity: { ...identity, runtimePort: 3901 } }).length, 1);
	assert.equal(compareHostedSessionContinuityAcrossRuntimeRestart({ ...before, validatedHostedSessions: [{ ...before.validatedHostedSessions[0], hostProcessInstanceId: undefined }] }, after).length, 1);
	assert.equal(observeHostedSessionIoProgressAfterRuntimeRestart(before, after)[0].nativeInputAcceptanceObserved, false);
	assert.deepEqual(observeHostedSessionIoProgressAfterRuntimeRestart(before, { ...after, validatedHostedSessions: [{ ...before.validatedHostedSessions[0], outputEndByteOffset: 4, currentRuntimeDeliveredHostedOutputEndByteOffset: 4, mostRecentPromptSubmissionId: "after", mostRecentNativePromptAcceptedAtEpochMs: 200 }] }, after).map(({ outputProgressObserved, nativeInputAcceptanceObserved }) => ({ outputProgressObserved, nativeInputAcceptanceObserved })), [{ outputProgressObserved: true, nativeInputAcceptanceObserved: true }]);
	process.stdout.write("连续性观察隔离自检通过；未重启、停止或输入任何会话。\n");
 } else {
	try {
		const baselinePath = valueOf("--before-restart-evidence-file");
		if (!baselinePath) throw new Error("需要与本次已授权部署绑定的 --before-restart-evidence-file");
		const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
		if (!baseline.ok || !baseline.validatedHostedSessions?.length) throw new Error("部署前证据未通过或没有活 hosted 会话，不能宣称连续性已验证");
		const sourceCommit = valueOf("--deployed-source-commit");
		if (arguments_.includes("--record-for-current-runtime") && (!/^[a-f0-9]{40}$/u.test(sourceCommit ?? "") || baseline.candidateSourceCommit !== sourceCommit)) throw new Error("记录连续性需要与部署前证据绑定的完整候选源 commit");
		const observationDeadlineMs = Number(valueOf("--observation-deadline-ms") ?? "120000");
		if (!Number.isFinite(observationDeadlineMs) || observationDeadlineMs <= 0) throw new Error("观察预算必须为正数毫秒");
		const observationDeadlineAtEpochMs = Date.now() + observationDeadlineMs;
		const startingPointFile = valueOf("--after-restart-observation-starting-point-file");
		let afterRestartObservationStartingPoint;
		let completed = false;
		let latestFailure = "尚未观察到部署后的 runtime";
		let persistedIoFingerprint = null;
		const writeEvidence = async (path, evidence) => {
			await mkdir(dirname(path), { recursive: true });
			const pendingPath = `${path}.pending-${process.pid}`;
			await writeFile(pendingPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
			await rename(pendingPath, path);
		};
		const readEvidenceIfPresent = async (path) => {
			try { return JSON.parse(await readFile(path, "utf8")); }
			catch (error) { if (error.code === "ENOENT") return null; throw error; }
		};
		while (Date.now() < observationDeadlineAtEpochMs) {
			try {
				const after = assessAgentSessionPtyHostDeploymentEvidence(await readLiveAgentSessionPtyHostDeploymentEvidence(), { requireAllSessionsPreservable: true });
				const failures = compareHostedSessionContinuityAcrossRuntimeRestart(baseline, after);
				if (failures.length) throw new Error(failures.join("；"));
				const processStartDigest = createHash("sha256").update(after.runtimeProcessStartTimeText).digest("hex").slice(0, 16);
				const currentRuntimeRecordPath = arguments_.includes("--record-for-current-runtime") ? join(after.runtimeIdentity.runtimeHomeDirectoryPath, "deployment-session-continuity", "runtime-observations", `${after.runtimeProcessId}-${processStartDigest}.json`) : null;
				if (!afterRestartObservationStartingPoint) {
					const previous = (startingPointFile ? await readEvidenceIfPresent(startingPointFile) : null) ?? (currentRuntimeRecordPath ? await readEvidenceIfPresent(currentRuntimeRecordPath) : null);
					if (previous) {
						if (previous.beforeRestartEvidenceFilePath !== baselinePath || previous.sourceCommitAtObservation !== (sourceCommit ?? baseline.candidateSourceCommit ?? null)) throw new Error("已保存的观察起点不属于本次部署基线或候选 commit");
						afterRestartObservationStartingPoint = previous.afterRestartObservationStartingPoint;
					}
					afterRestartObservationStartingPoint ??= after;
				}
				if (afterRestartObservationStartingPoint.runtimeProcessId !== after.runtimeProcessId || normalizePosixProcessStartTimeText(afterRestartObservationStartingPoint.runtimeProcessStartTimeText) !== normalizePosixProcessStartTimeText(after.runtimeProcessStartTimeText) || compareHostedSessionContinuityAcrossRuntimeRestart(baseline, afterRestartObservationStartingPoint).length) throw new Error("观察起点不属于当前新 runtime 的原会话身份");
				if (startingPointFile && persistedIoFingerprint === null) await writeEvidence(startingPointFile, { beforeRestartEvidenceFilePath: baselinePath, sourceCommitAtObservation: sourceCommit ?? baseline.candidateSourceCommit ?? null, afterRestartObservationStartingPoint });
				const ioProgressObservations = observeHostedSessionIoProgressAfterRuntimeRestart(baseline, after, afterRestartObservationStartingPoint);
				const sessionIoProgressVerified = ioProgressObservations.every(observation => observation.outputProgressObserved && observation.nativeInputAcceptanceObserved !== false);
				const requestedAssertionsPassed = !arguments_.includes("--require-session-io-progress") || sessionIoProgressVerified;
				const evidence = { ok: requestedAssertionsPassed, beforeRestartEvidenceFilePath: baselinePath, sourceCommitAtObservation: sourceCommit ?? baseline.candidateSourceCommit ?? null, checkedAtEpochMs: Date.now(), continuity: after, afterRestartObservationStartingPoint, ioProgressObservations, identityContinuityVerified: true, sessionIoProgressVerified, inputVerification: "只读观察，不向生产会话注入输入；输出须在新 runtime 的观察起点之后产生并实际送达" };
				const ioFingerprint = JSON.stringify(ioProgressObservations);
				if (currentRuntimeRecordPath && persistedIoFingerprint !== ioFingerprint) {
					await writeEvidence(currentRuntimeRecordPath, evidence);
					persistedIoFingerprint = ioFingerprint;
				}
				if (requestedAssertionsPassed) {
					const outputPath = valueOf("--after-restart-evidence-file");
					if (outputPath) await writeEvidence(outputPath, evidence);
					process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
					completed = true;
					break;
				}
				latestFailure = "原进程/会话身份连续；观察起点之后的自然输出送达或新原生输入接受仍待验";
			} catch (error) { latestFailure = error instanceof Error ? error.message : String(error); }
			await waitForRuntimeObservation(Math.min(2_000, Math.max(0, observationDeadlineAtEpochMs - Date.now())));
		}
		if (!completed) throw new Error(`连续性观察预算耗尽：${latestFailure}`);
	} catch (error) {
		process.stderr.write(`连续性未获证明：${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
