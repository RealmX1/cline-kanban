// 真实 headless 协议验收：只使用内存中的虚构材料，不建卡、不写业务账本。
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { incomingWorkItemRelationAnalysisSchema, incomingWorkItemSchema, type TaskIndexingMaterial } from "../../src/core/task-indexing-support-contract.ts";
import { INCOMING_WORK_ITEM_RELATION_INSTRUCTIONS, validateIncomingWorkItemRelationCandidates } from "../../src/task-indexing-support/incoming-work-item-relation-analysis.ts";
import { advanceSharedTaskIndexingSnapshot } from "../../src/task-indexing-support/shared-task-indexing-context.ts";
import { executeStatelessTaskIndexingAgent } from "../../src/task-indexing-support/stateless-task-indexing-agent-executor.ts";

const directory = process.argv[2];
if (!directory) throw new Error("必须给出持久证据目录。");
await mkdir(directory, { recursive: true });
process.env.KANBAN_DIAGNOSTIC_EVENT_JOURNAL_ROOT_DIR = resolve(directory, "usage-journals");
const task: TaskIndexingMaterial = {
	taskReference: { workUnitType: "kanban_board_card", workspaceId: "isolated-verification", taskId: "known-task", taskIncarnationCreatedAtEpochMs: 1000 },
	projectName: "协议验收材料", title: "阻止订单提交按钮重复发送请求", prompt: "修复订单提交按钮在第一次请求未完成时还能再次点击的问题。请求进行中必须禁用按钮，成功或失败后恢复。用重复点击的自动化测试验收。", columnId: "in_progress",
	latestNotificationSummaryText: null, latestHookFinalMessage: null, claudeAwaySummary: null, missingContextParts: [],
};
const item = incomingWorkItemSchema.parse({ schema_version: 1, work_item_key: "protocol-verification-only", title: "订单提交请求未完成时应阻止重复点击", prompt: "订单提交按钮在第一次请求未完成时仍能再次点击，导致重复请求。请在请求期间禁用按钮，结束后恢复，并增加重复点击测试。", evidence: ["protocol-fixture:order-submit"] });
const context = advanceSharedTaskIndexingSnapshot(null, { workspaceId: "isolated-verification", materials: [task], settings: { agentId: "codex", modelId: null }, instructionVersion: "protocol-verification", now: Date.now() }).context;
const result = await executeStatelessTaskIndexingAgent({ settings: { agentId: "codex", modelId: null }, instructionText: INCOMING_WORK_ITEM_RELATION_INSTRUCTIONS, context,
	queryText: JSON.stringify({ workspaceId: "isolated-verification", incomingWorkItem: item, knownTaskIdentities: [task.taskReference], completeTaskRequirements: [{ taskReference: task.taskReference, title: task.title, prompt: task.prompt, columnId: task.columnId }] }), outputSchema: incomingWorkItemRelationAnalysisSchema });
const analysis = validateIncomingWorkItemRelationCandidates({ workspaceId: "isolated-verification", item, analysis: result.value, materials: [task], fullRequirements: [task] });
if (analysis.relation_candidates[0]?.task_reference.taskId !== "known-task") throw new Error("真实协议返回了错误身份或未识别明确相同工作。");
await writeFile(resolve(directory, "codex-structured-analysis.json"), JSON.stringify({ ...result, validatedAnalysis: analysis }, null, 2));
process.stdout.write(`${JSON.stringify({ usage: result.usage, relationCount: analysis.relation_candidates.length, coverage: analysis.relation_candidates[0]?.coverage, diagnosticWarnings: result.diagnosticWarnings })}\n`);
