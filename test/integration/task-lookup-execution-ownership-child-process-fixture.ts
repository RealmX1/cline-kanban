import { z } from "zod";
import type { TaskLookupConversation } from "../../src/core/task-lookup-conversation-contract";
import { startRuntimeProcessInstanceHeartbeat } from "../../src/state/runtime-process-instance-heartbeat-registry";
import { createTaskLookupConversationService } from "../../src/task-indexing-support/task-lookup-conversation-service";

const storageDirectoryPath = process.argv[2];
if (!storageDirectoryPath) throw new Error("缺少隔离历史目录。");
const heartbeat = await startRuntimeProcessInstanceHeartbeat();
let releaseExecution = () => {};
let executionEntered = () => {};
let entered = Promise.resolve();
let released = Promise.resolve();
const service = createTaskLookupConversationService({
	storageDirectoryPath,
	collectMaterials: async () => ({ materials: [], missingContextParts: [] }),
	getExecutorSettings: async () => ({ agentId: "codex", modelId: null }),
	getContext: async () => ({
		schemaVersion: 1,
		workspaceId: "isolated",
		levelOneBoardTaskIndexText: "",
		levelTwoProjectTaskRecapsText: "",
		levelThreeAppendedChangesText: "",
		snapshotFingerprint: "isolated",
		contextCompleteness: [],
		asOf: Date.now(),
		rebuildReason: null,
	}),
	executeAgent: async (request) => {
		executionEntered();
		await released;
		return {
			value: request.outputSchema.parse(
				JSON.parse(request.queryText).phase === "recall"
					? { candidateTaskReferences: [] }
					: { answerText: "隔离桩结果", candidates: [] },
			),
			usage: { resolvedModelId: null },
			stablePromptPrefixSha256: "isolated",
			elapsedMs: 1,
			diagnosticWarnings: [],
		};
	},
});
const commandSchema = z.object({
	requestId: z.string(),
	operation: z.enum(["start", "read", "release", "close"]),
	conversationId: z.string().optional(),
});
process.on("message", (raw) => {
	void (async () => {
		const command = commandSchema.parse(raw);
		try {
			let conversation: TaskLookupConversation | undefined;
			if (command.operation === "start") {
				entered = new Promise<void>((resolve) => {
					executionEntered = resolve;
				});
				released = new Promise<void>((resolve) => {
					releaseExecution = resolve;
				});
				conversation = await service.createConversation({
					contextWorkspaceId: "isolated",
					scope: { projectIds: [], columnIds: [] },
				});
				await service.submitTurn({
					conversationId: conversation.conversationId,
					requestId: command.requestId,
					questionText: "跨进程隔离测试",
				});
				await entered;
				conversation = await service.getConversation(conversation.conversationId);
			} else if (command.operation === "read" && command.conversationId)
				conversation = await service.getConversation(command.conversationId);
			else if (command.operation === "release") {
				releaseExecution();
				await service.waitForIdle();
			} else if (command.operation === "close") {
				releaseExecution();
				await service.close();
				await heartbeat.stop();
			}
			process.send?.({ requestId: command.requestId, conversation });
			if (command.operation === "close") process.disconnect?.();
		} catch (error) {
			process.send?.({
				requestId: command.requestId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	})();
});
process.on("disconnect", () => {
	releaseExecution();
	void service.close().then(() => heartbeat.stop());
});
process.send?.({ kind: "ready", owningRuntimeProcessInstanceId: heartbeat.runtimeProcessInstanceId });
