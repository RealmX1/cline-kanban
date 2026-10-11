import { describe, expect, it } from "vitest";

import {
	canAgentResumeByRecordedNativeConversationSessionId,
	isAgentNativeConversationSessionIdAssignedByKanbanBeforeLaunch,
	isRestorationContinuationGuardDisarmedOnTerminalSubmissionEdge,
	RUNTIME_AGENT_CATALOG,
	RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS,
} from "../../../src/core/agent-catalog";

describe("agent catalog native conversation session identity capability", () => {
	it("declares how every launchable agent's native session id is captured, so a missing capture path is a visible fact", () => {
		// Cursor 曾经整整一年没有任何采集路径：续跑一律 `--continue` 猜 cwd 最近一段。显式声明（含 not_captured）
		// 让这类缺口在新增 agent 时就摆在桌面上。
		for (const agentId of RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS) {
			const entry = RUNTIME_AGENT_CATALOG.find((candidate) => candidate.id === agentId);
			expect(entry?.nativeConversationSessionIdentityCaptureMethod, agentId).toBeDefined();
			expect(entry?.restorationContinuationGuardDisarmSignal, agentId).toBeDefined();
		}
	});

	it("keeps the resume-by-recorded-id allow list identical to the agents that actually record an id", () => {
		const resumableByRecordedId = RUNTIME_AGENT_CATALOG.map((entry) => entry.id)
			.filter(canAgentResumeByRecordedNativeConversationSessionId)
			.sort();
		expect(resumableByRecordedId).toEqual(["claude", "codex", "cursor", "kimi", "omp"]);
		expect(canAgentResumeByRecordedNativeConversationSessionId("not-a-catalog-agent")).toBe(false);
	});

	it("assigns the native id before launch only for Cursor, and disarms the restoration guard on the submit edge for agents without a reliable submit hook", () => {
		expect(
			RUNTIME_AGENT_CATALOG.filter((entry) =>
				isAgentNativeConversationSessionIdAssignedByKanbanBeforeLaunch(entry.id),
			).map((entry) => entry.id),
		).toEqual(["cursor"]);
		expect(
			RUNTIME_AGENT_CATALOG.filter((entry) =>
				isRestorationContinuationGuardDisarmedOnTerminalSubmissionEdge(entry.id),
			)
				.map((entry) => entry.id)
				.sort(),
		).toEqual(["codex", "cursor"]);
		expect(isRestorationContinuationGuardDisarmedOnTerminalSubmissionEdge(null)).toBe(false);
	});
});
