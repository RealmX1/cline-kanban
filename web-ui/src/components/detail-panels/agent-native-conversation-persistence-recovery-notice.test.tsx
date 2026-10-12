import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentNativeConversationPersistenceRecoveryNotice } from "@/components/detail-panels/agent-native-conversation-persistence-recovery-notice";
import type { RuntimeTaskAgentSessionInitialization, RuntimeTaskSessionSummary } from "@/runtime/types";

const conversationFromTaskAChosenForAdoption: RuntimeTaskAgentSessionInitialization = {
	sourceAgentId: "cursor",
	sourceSessionId: "11111111-1111-4111-8111-111111111111",
	sourceSessionReuseMode: "resume_existing_session",
	sourceSessionWorkingDirectoryPath: "/tmp/worktrees/task-a",
};

// 真实的会话选择器要走 tRPC 拉会话列表；这里只关心「恢复条把选中值存在哪、何时清空」，
// 所以换成一个受控桩：一个按钮把固定对话写进 onChange，一段文字回显当前受控值。
vi.mock("@/components/task-agent-session-initialization-control", () => ({
	TaskAgentSessionInitializationControl: ({
		value,
		onChange,
	}: {
		value: RuntimeTaskAgentSessionInitialization | undefined;
		onChange: (value: RuntimeTaskAgentSessionInitialization | undefined) => void;
	}) => (
		<div>
			<span data-testid="adoption-candidate-currently-selected-in-picker">
				{value?.sourceSessionId ?? "未选择待迁入对话"}
			</span>
			<button type="button" onClick={() => onChange(conversationFromTaskAChosenForAdoption)}>
				在选择器里选中一段对话
			</button>
		</div>
	),
}));

function createSummaryWithConversationNeverEstablishedInAgentNativeStore(
	taskId: string,
	observedAt = 1,
): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "awaiting_review",
		agentId: "cursor",
		workspacePath: `/tmp/worktrees/${taskId}`,
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: "exit",
		exitCode: 1,
		lastHookAt: null,
		latestHookActivity: null,
		agentNativeConversationPersistenceObservation: {
			persistenceStatus: "conversation_never_established_in_agent_native_store",
			nativeSessionId: null,
			workingDirectoryPath: `/tmp/worktrees/${taskId}`,
			suspectedBlockingCause: null,
			observedAt,
		},
	};
}

// AlertDialog 走 Radix Portal，挂在 document.body 上而不是测试容器里。
function findButtonInDocumentByLabel(label: string): HTMLButtonElement | null {
	return [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === label) ?? null;
}

function readAdoptionCandidateCurrentlySelectedInPicker(): string | null {
	return (
		document.body.querySelector('[data-testid="adoption-candidate-currently-selected-in-picker"]')?.textContent ??
		null
	);
}

describe("AgentNativeConversationPersistenceRecoveryNotice", () => {
	let container: HTMLDivElement;
	let root: Root;
	const adoptExistingAgentConversationAndResume = vi.fn(
		async (_initialization: RuntimeTaskAgentSessionInitialization) => {},
	);

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		adoptExistingAgentConversationAndResume.mockClear();
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	function renderRecoveryNoticeForSummary(summary: RuntimeTaskSessionSummary): void {
		act(() => {
			root.render(
				<AgentNativeConversationPersistenceRecoveryNotice
					summary={summary}
					workspaceId="workspace-1"
					originalTaskPromptForFreshStart="/cline-kanban-local-deploy"
					isRestartingAgentSession={false}
					onAdoptExistingAgentConversationAndResume={adoptExistingAgentConversationAndResume}
				/>,
			);
		});
	}

	function chooseConversationInAdoptDialogThenCancel(): void {
		act(() => {
			findButtonInDocumentByLabel("从既有 Cursor 对话迁入…")?.click();
		});
		act(() => {
			findButtonInDocumentByLabel("在选择器里选中一段对话")?.click();
		});
		// 前置健全性：选中后「迁入并续跑」确实可点，否则下面「切会话后不可点」的断言就没有意义。
		expect(findButtonInDocumentByLabel("迁入并续跑")?.disabled).toBe(false);
		act(() => {
			findButtonInDocumentByLabel("取消")?.click();
		});
		expect(findButtonInDocumentByLabel("迁入并续跑")).toBeNull();
	}

	it("同一个实例切到另一条会话（summary.taskId 变化）后，上一条会话选中的待迁入对话被清空、迁入按钮不可用", () => {
		renderRecoveryNoticeForSummary(createSummaryWithConversationNeverEstablishedInAgentNativeStore("task-a"));
		chooseConversationInAdoptDialogThenCancel();

		// 宿主面板不卸载、只把 summary 换成另一张卡的（CardDetailView 切卡 / 切子会话就是这样）。
		renderRecoveryNoticeForSummary(createSummaryWithConversationNeverEstablishedInAgentNativeStore("task-b"));
		act(() => {
			findButtonInDocumentByLabel("从既有 Cursor 对话迁入…")?.click();
		});

		expect(readAdoptionCandidateCurrentlySelectedInPicker()).toBe("未选择待迁入对话");
		const adoptAndResumeButton = findButtonInDocumentByLabel("迁入并续跑");
		expect(adoptAndResumeButton?.disabled).toBe(true);
		act(() => {
			adoptAndResumeButton?.click();
		});
		expect(adoptExistingAgentConversationAndResume).not.toHaveBeenCalled();
	});

	it("同一条会话的 summary 更新（taskId 不变）不会清掉已选中的待迁入对话", () => {
		renderRecoveryNoticeForSummary(createSummaryWithConversationNeverEstablishedInAgentNativeStore("task-a", 1));
		chooseConversationInAdoptDialogThenCancel();

		renderRecoveryNoticeForSummary(createSummaryWithConversationNeverEstablishedInAgentNativeStore("task-a", 2));
		act(() => {
			findButtonInDocumentByLabel("从既有 Cursor 对话迁入…")?.click();
		});

		expect(readAdoptionCandidateCurrentlySelectedInPicker()).toBe(
			conversationFromTaskAChosenForAdoption.sourceSessionId,
		);
		act(() => {
			findButtonInDocumentByLabel("迁入并续跑")?.click();
		});
		expect(adoptExistingAgentConversationAndResume).toHaveBeenCalledWith(conversationFromTaskAChosenForAdoption);
	});
});
