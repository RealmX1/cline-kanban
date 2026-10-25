import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	independentTaskCreationDraftEditSchema,
	independentTaskCreationDraftSchema,
} from "../../../src/core/independent-task-creation-contract";
import { renderTaskInitialPromptAuthoringAndStartupSettingsGuidance } from "../../../src/core/task-initial-prompt-authoring-and-startup-settings-guidance";
import * as sourceAgentDraftGeneration from "../../../src/independent-task-creation/generate-draft-with-source-agent-fork";
import { createIndependentTaskCreationService } from "../../../src/independent-task-creation/independent-task-creation-service";
import {
	readIndependentTaskCreationDraft,
	writeIndependentTaskCreationDraft,
} from "../../../src/independent-task-creation/persisted-creation-draft";
import * as modelProviderChatCompletion from "../../../src/model-provider-access/request-model-provider-chat-completion";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});
describe("持久任务草稿生成", () => {
	it.each(["kanban_model_provider", "source_agent_fork"] as const)(
		"%s 实际生成请求复用共享起草规则，并保留本次范围及历史收尾材料",
		async (generationSource) => {
			const fixture = createIsolatedGitTestWorkspaceFixture();
			vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
			const requestId = "11111111-1111-4111-8111-111111111111";
			const draft = independentTaskCreationDraftSchema.parse({
				requestId,
				sourceTaskId: "source",
				sourceTaskConversationSessionId: "peer",
				revision: 0,
				status: "ready",
				userTaskDescription: "实现新任务，按本任务约定审查",
				suggestedTaskDescription: "",
				title: "",
				initialPrompt: "",
				titleWasEditedByUser: false,
				initialPromptWasEditedByUser: false,
				contextInheritance: "fresh_conversation",
				worktreeSource: "local_main_immediately",
				generationSource,
				generatedFromDescription: null,
				contextCapturedAt: 1,
				contextWarnings: [],
				forkUnavailableReason: null,
				sourceGitStatus: "",
				sourceCommitsNotInLocalMain: 0,
				errorMessage: null,
				createdTaskId: null,
			});
			await writeIndependentTaskCreationDraft("test", {
				draft,
				sourceSummary: null,
				contextBeforeSideSession: "[user; parent:1]\n本阶段只调查",
				contextAfterSideSession: "[assistant; side:2]\n不要开启新 RVF，直接提交并继续 base-branch-sync。",
				nativeConversationSeed: null,
				reservedTaskId: null,
				generationAttemptId: null,
			});
			const generatedDefinition = {
				suggestedTaskDescription: "实现新任务",
				title: "[FEAT]实现新任务",
				initialPrompt: "## TLDR\n\n实现新任务。\n\n按当前约定验证。\n\n<task-initial-prompt />",
			};
			const result = { status: "completed" as const, parsedJsonObject: generatedDefinition };
			const provider = vi
				.spyOn(modelProviderChatCompletion, "requestModelProviderJsonObject")
				.mockResolvedValue(result);
			const sourceAgent = vi
				.spyOn(sourceAgentDraftGeneration, "generateIndependentTaskDraftWithSourceAgentFork")
				.mockResolvedValue(result);
			const service = createIndependentTaskCreationService();
			const generated = await service.generate(
				{ workspaceId: "test", workspacePath: join(fixture.fixtureRootDirectoryPath, "repository") },
				{ requestId },
			);
			const prompt =
				generationSource === "kanban_model_provider"
					? `${provider.mock.calls[0]?.[0].systemPrompt}\n\n${provider.mock.calls[0]?.[0].userPrompt}`
					: sourceAgent.mock.calls[0]?.[0].prompt;
			expect(provider).toHaveBeenCalledTimes(generationSource === "kanban_model_provider" ? 1 : 0);
			expect(sourceAgent).toHaveBeenCalledTimes(generationSource === "source_agent_fork" ? 1 : 0);
			const guidance = renderTaskInitialPromptAuthoringAndStartupSettingsGuidance();
			expect(prompt?.split(guidance)).toHaveLength(2);
			expect(prompt).toContain("Markdown 标题 ## TLDR");
			expect(prompt).toContain("不能把它们自动改写成新任务的免审规则、提交授权或同步授权");
			expect(prompt).toContain("## 本次分出说明\n\n实现新任务，按本任务约定审查");
			expect(prompt).toContain("[assistant; side:2]\n不要开启新 RVF，直接提交并继续 base-branch-sync。");
			expect(generated.initialPrompt).toBe(generatedDefinition.initialPrompt);
		},
	);
	it("JSON 编辑快照可清除 provider 覆盖，重读后生成使用用途默认绑定", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		const requestId = "11111111-1111-4111-8111-111111111111";
		const draft = independentTaskCreationDraftSchema.parse({
			requestId,
			sourceTaskId: "source",
			sourceTaskConversationSessionId: "peer",
			revision: 0,
			status: "ready",
			userTaskDescription: "目标",
			suggestedTaskDescription: "",
			title: "",
			initialPrompt: "",
			titleWasEditedByUser: false,
			initialPromptWasEditedByUser: false,
			contextInheritance: "fresh_conversation",
			worktreeSource: "local_main_immediately",
			generatedFromDescription: null,
			contextCapturedAt: 1,
			contextWarnings: [],
			forkUnavailableReason: null,
			sourceGitStatus: "",
			sourceCommitsNotInLocalMain: 0,
			errorMessage: null,
			createdTaskId: null,
		});
		await writeIndependentTaskCreationDraft("test", {
			draft,
			sourceSummary: null,
			contextBeforeSideSession: "前段",
			contextAfterSideSession: "后段",
			nativeConversationSeed: null,
			reservedTaskId: null,
			generationAttemptId: null,
		});
		const requestGeneration = vi.fn(async () => ({
			status: "completed" as const,
			parsedJsonObject: { suggestedTaskDescription: "模型建议", title: "模型标题", initialPrompt: "模型正文" },
		}));
		const service = createIndependentTaskCreationService({ requestGeneration });
		const scope = { workspaceId: "test", workspacePath: join(fixture.fixtureRootDirectoryPath, "repository") };
		const selected = await service.saveDraft(
			scope,
			independentTaskCreationDraftEditSchema.parse(
				JSON.parse(
					JSON.stringify({ ...draft, expectedRevision: draft.revision, modelProviderId: "selected-provider" }),
				),
			),
		);
		expect(selected.modelProviderId).toBe("selected-provider");
		const generated = await service.generate(scope, { requestId });
		expect(requestGeneration).toHaveBeenLastCalledWith(
			expect.objectContaining({ modelProviderId: "selected-provider" }),
		);
		const defaultBindingEdit = independentTaskCreationDraftEditSchema.parse(
			JSON.parse(JSON.stringify({ ...generated, expectedRevision: generated.revision, modelProviderId: undefined })),
		);
		expect(defaultBindingEdit).not.toHaveProperty("modelProviderId");
		const cleared = await service.saveDraft(scope, defaultBindingEdit);
		expect(cleared.modelProviderId).toBeUndefined();
		const restartedService = createIndependentTaskCreationService({ requestGeneration });
		expect((await restartedService.read(scope, { requestId })).modelProviderId).toBeUndefined();
		await restartedService.generate(scope, { requestId });
		expect(requestGeneration).toHaveBeenCalledTimes(2);
		expect(requestGeneration).toHaveBeenLastCalledWith(expect.objectContaining({ modelProviderId: undefined }));
	});

	it("迟到的模型结果不能覆盖用户在生成期间修改的正文，修改跨实例保留", async () => {
		const fixture = createIsolatedGitTestWorkspaceFixture();
		vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
		const requestId = "11111111-1111-4111-8111-111111111111";
		const draft = independentTaskCreationDraftSchema.parse({
			requestId,
			sourceTaskId: "source",
			sourceTaskConversationSessionId: "peer",
			revision: 0,
			status: "ready",
			userTaskDescription: "目标",
			suggestedTaskDescription: "",
			title: "",
			initialPrompt: "",
			titleWasEditedByUser: false,
			initialPromptWasEditedByUser: false,
			contextInheritance: "fresh_conversation",
			worktreeSource: "local_main_immediately",
			generatedFromDescription: null,
			contextCapturedAt: 1,
			contextWarnings: [],
			forkUnavailableReason: null,
			sourceGitStatus: "",
			sourceCommitsNotInLocalMain: 0,
			errorMessage: null,
			createdTaskId: null,
		});
		await writeIndependentTaskCreationDraft("test", {
			draft,
			sourceSummary: null,
			contextBeforeSideSession: "前段",
			contextAfterSideSession: "后段",
			nativeConversationSeed: null,
			reservedTaskId: null,
			generationAttemptId: null,
		});
		let finish: (value: {
			status: "completed";
			parsedJsonObject: { suggestedTaskDescription: string; title: string; initialPrompt: string };
		}) => void = () => {};
		const requestGeneration = vi.fn(
			() =>
				new Promise<{
					status: "completed";
					parsedJsonObject: { suggestedTaskDescription: string; title: string; initialPrompt: string };
				}>((resolve) => {
					finish = resolve;
				}),
		);
		const service = createIndependentTaskCreationService({ requestGeneration });
		const scope = { workspaceId: "test", workspacePath: join(fixture.fixtureRootDirectoryPath, "repository") };
		mkdirSync(scope.workspacePath);
		const pending = service.generate(scope, { requestId });
		await vi.waitFor(() => expect(requestGeneration).toHaveBeenCalledTimes(1));
		const inFlight = (await readIndependentTaskCreationDraft("test", requestId))?.draft;
		expect(inFlight).toBeDefined();
		if (!inFlight) throw new Error("草稿未持久化");
		await service.saveDraft(scope, {
			...inFlight,
			expectedRevision: inFlight.revision,
			initialPrompt: "用户手改",
			initialPromptWasEditedByUser: true,
		});
		finish({
			status: "completed",
			parsedJsonObject: { suggestedTaskDescription: "模型建议", title: "模型标题", initialPrompt: "迟到正文" },
		});
		expect((await pending).initialPrompt).toBe("用户手改");
		expect((await readIndependentTaskCreationDraft("test", requestId))?.draft.initialPrompt).toBe("用户手改");
		const interrupted = await readIndependentTaskCreationDraft("test", requestId);
		if (!interrupted) throw new Error("缺少持久草稿");
		interrupted.draft.status = "generating";
		interrupted.generationAttemptId = "interrupted-model-request";
		await writeIndependentTaskCreationDraft("test", interrupted);
		const restartedService = createIndependentTaskCreationService({ requestGeneration });
		expect(
			(
				await restartedService.latestDraft(scope, {
					sourceTaskId: "source",
					sourceTaskConversationSessionId: "peer",
				})
			)?.requestId,
		).toBe(requestId);
		const recovered = await restartedService.read(scope, { requestId });
		expect(recovered.status).toBe("ready");
		expect(recovered.errorMessage).toContain("未自动重试付费请求");
		expect(recovered.initialPrompt).toBe("用户手改");
		expect(requestGeneration).toHaveBeenCalledTimes(1);
	});
});
