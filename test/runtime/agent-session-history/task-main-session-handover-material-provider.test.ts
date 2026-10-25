import { describe, expect, it } from "vitest";
import { collectTaskMainSessionHandoverMaterial } from "../../../src/agent-session-history/task-main-session-handover-material-provider";
import { runtimeTaskSessionSummarySchema } from "../../../src/core/api-contract";

const input = {
	workspaceId: "project",
	workspacePath: "/workspace",
	workspaceGitStatus: "",
	workspaceHeadCommit: "head",
	card: {
		id: "task",
		title: "交接任务",
		prompt: "用户原始需求",
		baseRef: "main",
		startInPlanMode: false,
		createdAt: 1,
		updatedAt: 1,
	},
	sourceSummary: runtimeTaskSessionSummarySchema.parse({
		taskId: "task",
		agentId: "kimi",
		workspacePath: "/workspace",
		pid: null,
		startedAt: null,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: { finalMessage: "Agent 尚未核验的汇报" },
		turnOwner: null,
		liveness: "none",
		userTurnKind: null,
	}),
};
describe("交接材料的可替换意图来源", () => {
	it("可选提供方迟迟不返回时有界中止并交付原始材料", async () => {
		let signal: AbortSignal | undefined;
		const material = await collectTaskMainSessionHandoverMaterial({
			...input,
			userIntentContextProvider: {
				readUserIntentContext: async (request) => {
					signal = request.signal;
					return await new Promise<never>(() => {});
				},
			},
		});
		expect(signal?.aborted).toBe(true);
		expect(material.userIntentContext?.providerAvailability).toBe("unavailable");
		expect(material.taskPrompt).toBe("用户原始需求");
		expect(material.missingMaterialDescriptions.join("\n")).toContain("读取预算");
	});
	it("卷宗未接入仍交付原始材料，并保留工作单元身份、时间和缺口", async () => {
		const material = await collectTaskMainSessionHandoverMaterial(input);
		expect(material.taskPrompt).toBe("用户原始需求");
		expect(material.sourceAgentId).toBe("kimi");
		expect(material.userIntentContext).toMatchObject({
			providerAvailability: "unavailable",
			userIntentContextText: null,
			workUnitReference: { workspaceId: "project", taskId: "task", taskIncarnationCreatedAtEpochMs: 1 },
		});
		expect(material.missingMaterialDescriptions.join("\n")).toContain("未分类原始材料");
	});
	it("接受提供方的有出处卷宗，拒绝错任务或未来材料并回退原始材料", async () => {
		const readUserIntentContext = async (request: {
			workUnitReference: NonNullable<
				Awaited<ReturnType<typeof collectTaskMainSessionHandoverMaterial>>["userIntentContext"]
			>["workUnitReference"];
			conversationSessionReferences: NonNullable<
				Awaited<ReturnType<typeof collectTaskMainSessionHandoverMaterial>>["userIntentContext"]
			>["conversationSessionReferences"];
			readContextAsOf: number;
		}) => ({
			providerName: "intent_dossier_contract_fixture",
			providerAvailability: "available" as const,
			asOf: request.readContextAsOf,
			workUnitReference: request.workUnitReference,
			conversationSessionReferences: request.conversationSessionReferences,
			userIntentContextText: "带出处的用户要求",
			sourceReferences: ["user-message:1"],
			missingContextParts: [],
		});
		const available = await collectTaskMainSessionHandoverMaterial({
			...input,
			userIntentContextProvider: { readUserIntentContext },
		});
		expect(available.userIntentContext?.sourceReferences).toEqual(["user-message:1"]);
		const wrong = await collectTaskMainSessionHandoverMaterial({
			...input,
			userIntentContextProvider: {
				readUserIntentContext: async (request) => ({
					...(await readUserIntentContext(request)),
					workUnitReference: { ...request.workUnitReference, taskId: "other-task" },
				}),
			},
		});
		expect(wrong.userIntentContext?.providerAvailability).toBe("unavailable");
		expect(wrong.taskPrompt).toBe("用户原始需求");
		expect(wrong.userIntentContext?.userIntentContextText).toBeNull();
	});
});
