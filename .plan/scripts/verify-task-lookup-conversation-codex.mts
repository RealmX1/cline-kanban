import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskIndexingMaterial } from "../../src/core/task-indexing-support-contract";
import { advanceSharedTaskIndexingSnapshot } from "../../src/task-indexing-support/shared-task-indexing-context";
import { executeStatelessTaskIndexingAgent } from "../../src/task-indexing-support/stateless-task-indexing-agent-executor";
import { createTaskLookupConversationService, TASK_LOOKUP_INSTRUCTION_VERSION } from "../../src/task-indexing-support/task-lookup-conversation-service";

const artifactDirectory = process.env.KANBAN_TASK_LOOKUP_REAL_MODEL_EVIDENCE_DIRECTORY ?? "/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/task-3346b-task-lookup-workbench/real-codex-evidence";
await mkdir(artifactDirectory, { recursive: true });
const materials: TaskIndexingMaterial[] = [
	{ taskId: "api01", title: "持久多轮任务查询服务", prompt: "实现自然语言查卡服务，保存每轮问题、多个候选和匹配原因；重启后可继续补充条件。" },
	{ taskId: "ui002", title: "Search 接入任务查卡工作台", prompt: "Search 按描述查询，展示多个可能任务及理由；工作台支持补充条件和持久查询历史。" },
	{ taskId: "other", title: "调整终端字体大小", prompt: "为终端增加字号设置。" },
].map((entry) => ({ taskReference: { workUnitType: "kanban_board_card", workspaceId: "synthetic-lookup-verification", taskId: entry.taskId, taskIncarnationCreatedAtEpochMs: 1 }, projectName: "查卡隔离样本", title: entry.title, prompt: entry.prompt, columnId: "backlog", latestNotificationSummaryText: null, latestHookFinalMessage: null, claudeAwaySummary: null, missingContextParts: [] }));
const settings = { agentId: "codex" as const, modelId: null };
const service = createTaskLookupConversationService({
	storageDirectoryPath: join(artifactDirectory, "conversations"),
	collectMaterials: async () => ({ materials, missingContextParts: [] }),
	getExecutorSettings: async () => settings,
	getContext: async (workspaceId, currentMaterials) => advanceSharedTaskIndexingSnapshot(null, { workspaceId, materials: currentMaterials, settings, instructionVersion: TASK_LOOKUP_INSTRUCTION_VERSION, now: Date.now() }).context,
	executeAgent: executeStatelessTaskIndexingAgent,
});
try {
	const conversation = await service.createConversation({ contextWorkspaceId: "synthetic-lookup-verification", scope: { projectIds: [], columnIds: [] } });
	await service.submitTurn({ conversationId: conversation.conversationId, requestId: "real-codex-first", questionText: "哪些任务计划支持自然语言查卡、多轮补充条件和持久历史？返回相关的多个候选并解释各自承担的部分。" });
	await service.waitForIdle();
	const result = await service.getConversation(conversation.conversationId);
	await writeFile(join(artifactDirectory, "result.json"), JSON.stringify(result, null, 2));
	const turn = result.turns[0];
	if (turn?.status !== "completed" || !turn.result || turn.result.candidates.length < 2) throw new Error(`真实 Codex 验收未通过：${turn?.errorMessage ?? turn?.status}`);
	process.stdout.write(JSON.stringify({ status: turn.status, candidateTaskIds: turn.result.candidates.map((candidate) => candidate.taskReference.taskId), executions: turn.executions, evidencePath: join(artifactDirectory, "result.json") }, null, 2));
} finally { await service.close(); }
