import { beforeEach, expect, it, vi } from "vitest";
import * as analysisQueries from "@/runtime/task-analysis-query";
import * as taskCardQueries from "@/runtime/task-card-action-query";
import type { RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries } from "@/runtime/types";
import {
	resetUserInterfacePreferencesSharedAcrossBrowserOriginsStoreForTests,
	saveUserInterfacePreferencesSharedAcrossBrowserOrigins,
	USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
} from "@/runtime/user-interface-preferences-shared-across-browser-origins-store";
import { startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime } from "@/state/task-card-action-commands-for-any-workspace";
import {
	hasAcceptedTaskProjectAssignmentAnalysis,
	invalidateAcceptedTaskProjectAssignmentAnalyses,
} from "@/state/task-project-assignment-preflight";

vi.mock("@/runtime/task-card-action-query", () => ({
	readTaskCardWithBoardColumnInWorkspace: vi.fn(),
	startTaskCardAgentSessionMovingItIntoInProgressInWorkspace: vi.fn(),
}));
vi.mock("@/runtime/task-analysis-query", () => ({ requestTaskProjectAssignmentAnalysis: vi.fn() }));
vi.mock("@/runtime/runtime-config-query", () => ({
	saveRuntimeConfig: vi.fn(async () => ({
		userInterfacePreferencesSharedAcrossBrowserOrigins:
			USER_INTERFACE_PREFERENCES_SHARED_ACROSS_BROWSER_ORIGINS_WITH_NOTHING_SET,
	})),
}));
vi.mock("@/state/task-card-action-command-execution", () => ({
	executeTaskCardActionCommand: async (input: { sendCommand: () => Promise<unknown> }) => ({
		taskCardActionCommandExecutionOutcome: "command_completed_by_runtime",
		response: await input.sendCommand(),
	}),
}));

const startInput = { workspaceId: "project-1", taskId: "abcde" };
const backlogSnapshot: RuntimeTaskCardSnapshotWithBoardColumnAndTaskSessionSummaries = {
	taskCard: {
		id: "abcde",
		title: "启动任务",
		prompt: "任务正文",
		baseRef: "feature/task-base",
		startInPlanMode: false,
		createdAt: 1,
		updatedAt: 1,
	},
	boardColumnIdContainingTaskCard: "backlog",
	taskSessionSummaryLiveInRuntimeProcessMemory: null,
	taskSessionSummaryPersistedInWorkspaceSessionsFile: null,
};
const analysisResult: Awaited<ReturnType<typeof analysisQueries.requestTaskProjectAssignmentAnalysis>> = {
	operationId: "controlled-analysis",
	currentWorkspaceId: "project-1",
	inputFingerprint: "controlled",
	suggestedWorkspaceId: null,
	suggestedProjectName: null,
	rationale: "当前项目合适",
	confidence: "high",
	stablePromptPrefixSha256: "controlled",
};

beforeEach(() => {
	vi.clearAllMocks();
	resetUserInterfacePreferencesSharedAcrossBrowserOriginsStoreForTests();
	invalidateAcceptedTaskProjectAssignmentAnalyses();
	vi.mocked(taskCardQueries.readTaskCardWithBoardColumnInWorkspace).mockResolvedValue({
		taskCardLookupOutcome: "task_card_found_on_workspace_board",
		taskCardSnapshot: backlogSnapshot,
	});
	vi.mocked(analysisQueries.requestTaskProjectAssignmentAnalysis).mockResolvedValue(analysisResult);
	vi.mocked(taskCardQueries.startTaskCardAgentSessionMovingItIntoInProgressInWorkspace).mockResolvedValue({
		boardColumnIdOfTaskCardBeforeAction: "backlog",
		taskCardWasMovedIntoInProgressColumnByThisAction: true,
		agentSessionStartOutcome: "agent_session_started",
		agentSessionStartFailureMessage: null,
		ensuredTaskWorktreeWarningMessage: null,
		startedAgentSessionSummary: null,
		taskCardSnapshotAfterAction: { ...backlogSnapshot, boardColumnIdContainingTaskCard: "in_progress" },
	});
});

it.each([undefined, null, false])(
	"自动分析偏好为 %s 时直接启动不读取分析输入、不分析也不写接受缓存",
	async (preference) => {
		if (preference !== undefined)
			saveUserInterfacePreferencesSharedAcrossBrowserOrigins({
				taskProjectAssignmentAutomaticAnalysisEnabled: preference,
			});
		await startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime(startInput);
		expect(taskCardQueries.readTaskCardWithBoardColumnInWorkspace).not.toHaveBeenCalled();
		expect(analysisQueries.requestTaskProjectAssignmentAnalysis).not.toHaveBeenCalled();
		expect(taskCardQueries.startTaskCardAgentSessionMovingItIntoInProgressInWorkspace).toHaveBeenCalledWith(
			"project-1",
			expect.objectContaining({ taskId: "abcde" }),
		);
		expect(hasAcceptedTaskProjectAssignmentAnalysis("project-1", "abcde", "启动任务", "任务正文")).toBe(false);
	},
);

it("先关闭跳过再开启时仍分析同一任务，成功分析后才复用接受缓存", async () => {
	await startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime(startInput);
	saveUserInterfacePreferencesSharedAcrossBrowserOrigins({ taskProjectAssignmentAutomaticAnalysisEnabled: true });
	await startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime(startInput);
	expect(analysisQueries.requestTaskProjectAssignmentAnalysis).toHaveBeenCalledTimes(1);
	expect(hasAcceptedTaskProjectAssignmentAnalysis("project-1", "abcde", "启动任务", "任务正文")).toBe(true);
	await startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime(startInput);
	expect(analysisQueries.requestTaskProjectAssignmentAnalysis).toHaveBeenCalledTimes(1);
});

it("直接启动分析期间关闭开关不取消已经开始的分析", async () => {
	let completeAnalysis!: (value: typeof analysisResult) => void;
	vi.mocked(analysisQueries.requestTaskProjectAssignmentAnalysis).mockReturnValueOnce(
		new Promise((resolve) => {
			completeAnalysis = resolve;
		}),
	);
	saveUserInterfacePreferencesSharedAcrossBrowserOrigins({ taskProjectAssignmentAutomaticAnalysisEnabled: true });
	const started = startTaskCardAgentSessionMovingItIntoInProgressThroughRuntime(startInput);
	await vi.waitFor(() => expect(analysisQueries.requestTaskProjectAssignmentAnalysis).toHaveBeenCalledTimes(1));
	saveUserInterfacePreferencesSharedAcrossBrowserOrigins({ taskProjectAssignmentAutomaticAnalysisEnabled: false });
	completeAnalysis(analysisResult);
	await expect(started).resolves.toMatchObject({
		taskCardActionCommandExecutionOutcome: "command_completed_by_runtime",
	});
	expect(taskCardQueries.startTaskCardAgentSessionMovingItIntoInProgressInWorkspace).toHaveBeenCalledTimes(1);
});
