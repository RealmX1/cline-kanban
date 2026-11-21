import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskClosureSummaryAndHistory } from "@/components/task-closure-summary-and-history";
import type { BoardCard } from "@/types";

const readHistory = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/task-card-action-query", () => ({
	readTaskClosureHistoryInWorkspace: readHistory,
	cancelTaskClosureOperationInWorkspace: vi.fn(),
	correctTaskClosureOutcomeInWorkspace: vi.fn(),
}));

describe("持久结案恢复的历史面板", () => {
	let root: Root;
	let container: HTMLDivElement;
	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		readHistory.mockResolvedValue({ records: [], operations: [] });
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});
	const card: BoardCard = {
		id: "abc12",
		title: "隔离结案面板",
		prompt: "",
		baseRef: "main",
		startInPlanMode: false,
		createdAt: 1,
		updatedAt: 1,
	};
	const openHistory = async (withProgress: BoardCard) => {
		await act(async () =>
			root.render(<TaskClosureSummaryAndHistory card={withProgress} workspaceId="isolated" isClosed={false} />),
		);
		await act(async () => container.querySelector("button")?.click());
	};
	it("待恢复请求显示持久次数和修复补试状态，不提示重启可补发次数", async () => {
		await openHistory({
			...card,
			taskClosureOperationProgress: {
				closureRequestId: "11111111-1111-4111-8111-111111111111",
				phase: "preservation_waiting_for_recovery",
				attemptCount: 4,
				lastError: "相同软链失败",
				recoveryCondition: "等待相关修复",
				nextRetryAtEpochMs: null,
				automaticRecovery: {
					automaticAttemptCount: 4,
					maximumAutomaticAttemptCount: 4,
					repairSupplementConsumed: true,
					pendingSideEffect: "preserve_archive",
					failureClassification: "archive_restoration_verification_failed",
					failureRecoveryEvidenceFingerprint: "isolated",
					minimumRequiredAvailableStorageBytes: null,
					lastFailureAtEpochMs: 1,
				},
			},
		});
		expect(document.body.textContent).toContain("自动尝试已用 4 次，上限 4 次");
		expect(document.body.textContent).toContain("相关修复后的唯一补试已使用");
		expect(document.body.textContent).toContain("取消待恢复操作");
	});
	it("已取消请求仍能查看历史及回收断点，但不再提供恢复旧请求按钮", async () => {
		await openHistory({
			...card,
			taskClosureOperationProgress: {
				closureRequestId: "11111111-1111-4111-8111-111111111111",
				phase: "cancelled",
				attemptCount: 3,
				lastError: null,
				recoveryCondition: null,
				nextRetryAtEpochMs: null,
				unverifiedCandidateReclamation: {
					phase: "waiting_for_recovery",
					automaticAttemptCount: 2,
					lastError: "来源已变化，保留唯一载荷",
				},
			},
		});
		expect(document.body.textContent).toContain("结案请求已取消；历史尝试与保留载荷仍可查询");
		expect(document.body.textContent).toContain("回收已执行 2 次，最多三次");
		expect(document.body.textContent).not.toContain("取消待恢复操作");
	});
	it("独立重开待恢复也显示自己的次数并允许明确取消", async () => {
		readHistory.mockResolvedValue({
			records: [],
			operations: [],
			reopeningOperations: [
				{
					closureRequestId: "11111111-1111-4111-8111-111111111112",
					phase: "waiting_for_recovery",
					lastError: "恢复能力尚不可用",
					automaticRecovery: { automaticAttemptCount: 2, maximumAutomaticAttemptCount: 3 },
				},
			],
		});
		await openHistory({
			...card,
			taskClosureOperationProgress: {
				closureRequestId: "11111111-1111-4111-8111-111111111111",
				phase: "cancelled",
				attemptCount: 1,
				lastError: null,
				recoveryCondition: null,
				nextRetryAtEpochMs: null,
			},
		});
		expect(document.body.textContent).toContain("重开待恢复");
		expect(document.body.textContent).toContain("自动尝试已用 2 次，上限 3 次");
		expect(document.body.textContent).toContain("取消待恢复操作");
	});
});
