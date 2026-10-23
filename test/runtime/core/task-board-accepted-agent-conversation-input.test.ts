import { describe, expect, it } from "vitest";
import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import { projectTaskBoardAfterAcceptedMainConversationInput } from "../../../src/core/task-board-accepted-agent-conversation-input";

const ACCEPTED_AT_MS = 10_000;
const CURRENT_PROCESS_INCARNATION_ID = "current-process-incarnation";
const ACCEPTED_NATIVE_USER_MESSAGE_OBSERVATION = {
	status: "accepted" as const,
	attemptedAtMs: ACCEPTED_AT_MS - 100,
	confirmedAtMs: ACCEPTED_AT_MS,
	eventId: "accepted-native-user-message",
	runtimeSessionIncarnationId: CURRENT_PROCESS_INCARNATION_ID,
};

function createCard(overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id: "card",
		title: "真实接受输入后立即恢复工作",
		prompt: "继续处理任务",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: ACCEPTED_AT_MS - 1_000,
		...overrides,
	};
}

function createBoard(columnId: RuntimeBoardColumnId, card = createCard()): RuntimeBoardData {
	const columns: RuntimeBoardColumnId[] = ["backlog", "in_progress", "review", "validation", "trash"];
	return { columns: columns.map((id) => ({ id, title: id, cards: id === columnId ? [card] : [] })) };
}

function createAcceptedSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "card",
		state: "running",
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
		agentId: "codex",
		workspacePath: "/isolated/worktree",
		pid: 100,
		startedAt: 1,
		updatedAt: ACCEPTED_AT_MS,
		runtimeSessionIncarnationId: CURRENT_PROCESS_INCARNATION_ID,
		// 接受证明可先于任何正文或终端输出；纯运行时投影无需浏览器或屏幕信号。
		lastOutputAt: null,
		lastSubstantiveOutputAt: null,
		lastHookAt: null,
		latestHookActivity: null,
		reviewReason: null,
		exitCode: null,
		agentConversationPromptSubmissionAcceptance: ACCEPTED_NATIVE_USER_MESSAGE_OBSERVATION,
		...overrides,
	};
}

function createSideSessionMetadata(role: "main" | "task_collaborator" | "by_the_way") {
	return {
		workspaceTaskId: "card",
		taskConversationSessionRole: role,
		taskConversationSessionContextSource: "started_from_scratch" as const,
		parentTaskConversationSessionId: null,
		mainSessionOriginTurnNumber: null,
		mainSessionOriginUserMessagePreview: null,
		latestUserMessagePreview: null,
	};
}

function taskIdsInColumn(board: RuntimeBoardData, columnId: RuntimeBoardColumnId): string[] {
	return board.columns.find((column) => column.id === columnId)?.cards.map((card) => card.id) ?? [];
}

function expectUnchanged(board: RuntimeBoardData, summary: RuntimeTaskSessionSummary): void {
	const result = projectTaskBoardAfterAcceptedMainConversationInput(board, summary);
	expect(result.moved).toBe(false);
	expect(result.board).toBe(board);
}

describe("主对话原生输入接受边沿的服务端看板投影", () => {
	it.each(["review", "validation"] as const)(
		"%s 中的新主输入已经接受，无正文、无浏览器也立即进入 In Progress",
		(columnId) => {
			const board = createBoard(columnId);
			const result = projectTaskBoardAfterAcceptedMainConversationInput(board, createAcceptedSummary());
			expect(result.moved).toBe(true);
			expect(taskIdsInColumn(result.board, "in_progress")).toEqual(["card"]);
			expect(taskIdsInColumn(result.board, columnId)).toEqual([]);
			// 输入投影不原地修改原始看板，运行时可把新值交给持久化与广播。
			expect(taskIdsInColumn(board, columnId)).toEqual(["card"]);
		},
	);

	it.each(["pending", "unconfirmed"] as const)("只有 %s 状态不能冒充接受成功", (status) => {
		const accepted = createAcceptedSummary();
		expectUnchanged(createBoard("validation"), {
			...accepted,
			agentConversationPromptSubmissionAcceptance: {
				...ACCEPTED_NATIVE_USER_MESSAGE_OBSERVATION,
				status,
			},
		});
	});

	it.each(["eventId", "confirmedAtMs"] as const)("接受记录缺少 %s 时仍不能移卡", (missingProofField) => {
		expectUnchanged(
			createBoard("review"),
			createAcceptedSummary({
				agentConversationPromptSubmissionAcceptance: {
					...ACCEPTED_NATIVE_USER_MESSAGE_OBSERVATION,
					[missingProofField]: undefined,
				},
			}),
		);
	});

	it.each([undefined, null])("没有接受观测（%s）保持原列", (observation) => {
		expectUnchanged(
			createBoard("review"),
			createAcceptedSummary({ agentConversationPromptSubmissionAcceptance: observation }),
		);
	});

	it.each(["task_collaborator", "by_the_way"] as const)("%s 的新输入不改变主卡所属列", (role) => {
		expectUnchanged(
			createBoard("review"),
			createAcceptedSummary({
				taskId: "side-session",
				taskConversationSessionMetadata: createSideSessionMetadata(role),
			}),
		);
	});

	it("前主接受新输入时不能移卡；当前绑定的新主接受时可以", () => {
		const board = createBoard("validation", createCard({ mainTaskConversationSessionId: "new-main" }));
		expectUnchanged(board, createAcceptedSummary());
		const result = projectTaskBoardAfterAcceptedMainConversationInput(
			board,
			createAcceptedSummary({
				taskId: "new-main",
				taskConversationSessionMetadata: createSideSessionMetadata("main"),
			}),
		);
		expect(result.moved).toBe(true);
		expect(taskIdsInColumn(result.board, "in_progress")).toEqual(["card"]);
	});

	it("接受后用户较晚手动放回 Validation，同一旧边沿不再弹回", () => {
		const accepted = createAcceptedSummary();
		const first = projectTaskBoardAfterAcceptedMainConversationInput(createBoard("review"), accepted);
		expect(first.moved).toBe(true);
		const manuallyValidatedBoard = createBoard("validation", createCard({ updatedAt: ACCEPTED_AT_MS + 1 }));
		expectUnchanged(manuallyValidatedBoard, accepted);
		expect(taskIdsInColumn(manuallyValidatedBoard, "validation")).toEqual(["card"]);
	});

	it("重复消费时已在 In Progress，不重复移列", () => {
		const accepted = createAcceptedSummary();
		const first = projectTaskBoardAfterAcceptedMainConversationInput(createBoard("review"), accepted);
		expectUnchanged(first.board, accepted);
	});

	it("旧 incarnation 的接受证明不能移卡", () => {
		expectUnchanged(
			createBoard("review"),
			createAcceptedSummary({ runtimeSessionIncarnationId: "replacement-process" }),
		);
	});

	it("明确在等自己派发的后台工作时不移卡", () => {
		expectUnchanged(
			createBoard("review"),
			createAcceptedSummary({
				awaitingDispatchedBackgroundWork: { label: "等待协作审查", sinceMs: ACCEPTED_AT_MS - 1 },
			}),
		);
	});

	it("主交接暂停自动动作期间不移卡", () => {
		expectUnchanged(
			createBoard("review"),
			createAcceptedSummary({
				taskConversationSessionMetadata: {
					...createSideSessionMetadata("main"),
					taskAutomationSuspendedForMainSessionHandover: true,
				},
			}),
		);
	});

	it("已交回用户时不以旧接受事实重新开工", () => {
		expectUnchanged(
			createBoard("review"),
			createAcceptedSummary({ state: "awaiting_review", turnOwner: "user", userTurnKind: "review" }),
		);
	});

	it.each(["backlog", "in_progress", "trash"] as const)("接受边沿不越过 %s 列的既有规则", (columnId) => {
		expectUnchanged(createBoard(columnId), createAcceptedSummary());
	});
});
