import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	independentTaskCreationDraftEditSchema,
	independentTaskCreationDraftSchema,
} from "../../../src/core/independent-task-creation-contract";
import { createIndependentTaskCreationService } from "../../../src/independent-task-creation/independent-task-creation-service";
import {
	readIndependentTaskCreationDraft,
	writeIndependentTaskCreationDraft,
} from "../../../src/independent-task-creation/persisted-creation-draft";
import { createIsolatedGitTestWorkspaceFixture } from "../../git-repository-mutation-safety/isolated-git-test-workspace-fixture";

afterEach(() => vi.unstubAllEnvs());
describe("持久任务草稿生成", () => {
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
