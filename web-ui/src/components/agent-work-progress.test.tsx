import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { AgentWorkProgress } from "@/components/agent-work-progress";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

describe("任务进展的当前条目与历史", () => {
	it("卡片仅展示最新进展，详情中的历史默认折叠，完成与放弃具有可读状态", () => {
		const summary: RuntimeTaskSessionSummary = {
			taskId: "abc12",
			agentId: "codex",
			state: "running",
			turnOwner: "agent",
			liveness: "live",
			userTurnKind: null,
			workspacePath: "/test",
			pid: 1,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: 1,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			runtimeSessionIncarnationId: "runtime-1",
			agentNativeConversationSessionIdentity: {
				sourceAgentId: "codex",
				nativeSessionId: "native-1",
				transcriptPath: null,
				observedAt: 1,
			},
			agentWorkProgressEntries: ["completed", "abandoned", "in_progress"].map((outcome, index) => ({
				progressEntryId: `entry-${index}`,
				progressText: ["已定位问题", "放弃扩大上限", "验证分批查询"][index] ?? "当前进展",
				outcome: outcome as "completed" | "abandoned" | "in_progress",
				recordedAt: index,
				updatedAt: index,
				owningKanbanTaskConversationSessionId: "abc12",
				owningNativeConversationSessionId: "native-1",
				owningRuntimeSessionIncarnationId: "runtime-1",
				progressMutationFingerprint: `fingerprint-${index}`,
			})),
		};
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			act(() => root.render(<AgentWorkProgress summary={summary} />));
			expect(container.textContent).toContain("验证分批查询");
			expect(container.textContent).not.toContain("已定位问题");
			act(() => root.render(<AgentWorkProgress summary={summary} isProgressHistoryVisible />));
			const history = container.querySelector("details");
			expect(history?.open).toBe(false);
			act(() => history?.querySelector("summary")?.click());
			expect(history?.open).toBe(true);
			expect(container.querySelector('[aria-label="已完成"]')).not.toBeNull();
			expect(container.querySelector('[aria-label="已放弃"]')?.parentElement?.textContent).toContain("放弃扩大上限");
		} finally {
			act(() => root.unmount());
			container.remove();
		}
	});
});
