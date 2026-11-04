import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBoardCard, RuntimeTaskNameSuggestionResponse } from "../../src/core/api-contract";
import { updateTask } from "../../src/core/task-board-mutations";
import {
	loadPersistedWorkspaceStateById,
	loadWorkspaceContext,
	loadWorkspaceState,
	mutateWorkspaceState,
} from "../../src/state/workspace-state";
import {
	reconcileAutomaticTaskNameBackfills,
	requestAutomaticTaskNameBackfill,
} from "../../src/task-name-suggestion/automatic-task-name-backfill";
import * as suggestions from "../../src/task-name-suggestion/suggest-task-names-from-task-description";
import { createIsolatedGitTestWorkspaceFixture } from "../git-repository-mutation-safety/isolated-git-test-workspace-fixture";
import { TASK_MUTATION_INTENT_FOR_TEST_FIXTURE } from "../utilities/task-mutation-intent-for-test-fixture";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
async function scenario() {
	const fixture = createIsolatedGitTestWorkspaceFixture();
	vi.stubEnv("HOME", fixture.isolatedHomeDirectoryPath);
	vi.stubEnv("CODEX_HOME", join(fixture.isolatedHomeDirectoryPath, "isolated-codex-configuration"));
	vi.stubEnv("CODEX_SQLITE_HOME", join(fixture.isolatedHomeDirectoryPath, "isolated-codex-storage"));
	const repository = fixture.createNonBareRepository({ repositoryDirectoryName: "automatic-task-naming" });
	await writeFile(join(repository.repositoryPath, "initial.txt"), "隔离命名验证");
	repository.commitAllRepositoryFilesAtDate({
		message: "初始化隔离命名仓库",
		authorAndCommitterIsoDate: "2026-01-01T00:00:00Z",
	});
	await loadWorkspaceState(repository.repositoryPath);
	const context = await loadWorkspaceContext(repository.repositoryPath);
	const scope = { workspaceId: context.workspaceId, workspacePath: repository.repositoryPath };
	const card: RuntimeBoardCard = {
		id: "abcde",
		startInPlanMode: false,
		title: "原推导名称",
		prompt: "原始完整命名依据",
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
	await mutateWorkspaceState(scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
		board: {
			...state.board,
			columns: state.board.columns.map((column) =>
				column.id === "backlog" ? { ...column, cards: [card] } : column,
			),
		},
		value: undefined,
	}));
	const recordsDirectory = join(
		fixture.isolatedHomeDirectoryPath,
		".cline",
		"kanban",
		"automatic-task-name-backfills",
	);
	const readRecord = async () => {
		const [file] = await readdir(recordsDirectory);
		if (!file) throw new Error("命名记录未持久保存");
		return JSON.parse(await readFile(join(recordsDirectory, file), "utf8"));
	};
	const readCard = async () =>
		(await loadPersistedWorkspaceStateById(scope.workspaceId)).board.columns
			.flatMap((column) => column.cards)
			.find((entry) => entry.id === card.id);
	return { scope, card, readRecord, readCard };
}
const suggested: RuntimeTaskNameSuggestionResponse = { status: "suggested", suggestedTaskNames: ["[FIX]自动名称"] };
describe("运行时持久任务命名", () => {
	it("模型返回前手改再改回原名，迟到结果仍不能覆盖", async () => {
		const f = await scenario();
		let release!: (value: RuntimeTaskNameSuggestionResponse) => void;
		const naming = vi.spyOn(suggestions, "suggestTaskNamesFromTaskDescription").mockReturnValue(
			new Promise((resolve) => {
				release = resolve;
			}),
		);
		await requestAutomaticTaskNameBackfill(f.scope, f.card);
		await reconcileAutomaticTaskNameBackfills();
		await vi.waitFor(() => expect(naming).toHaveBeenCalledOnce());
		await mutateWorkspaceState(f.scope.workspacePath, TASK_MUTATION_INTENT_FOR_TEST_FIXTURE, (state) => ({
			board: updateTask(updateTask(state.board, f.card.id, { ...f.card, title: "人工名称" }).board, f.card.id, {
				...f.card,
				title: f.card.title,
			}).board,
			value: undefined,
		}));
		release(suggested);
		await vi.waitFor(async () => expect((await f.readRecord()).status).toBe("completed"));
		expect((await f.readCard())?.title).toBe(f.card.title);
		expect(naming).toHaveBeenCalledOnce();
	});
	it("请求结果未知时只查询原结果，取得持久结果后恢复且不重复调用模型", async () => {
		const f = await scenario();
		const naming = vi
			.spyOn(suggestions, "suggestTaskNamesFromTaskDescription")
			.mockRejectedValue(new Error("响应未知"));
		const original = vi.spyOn(suggestions, "readRecordedCreationNameSuggestionResult").mockResolvedValue(null);
		await requestAutomaticTaskNameBackfill(f.scope, f.card);
		await reconcileAutomaticTaskNameBackfills();
		await vi.waitFor(() => expect(naming).toHaveBeenCalledOnce());
		await vi.waitFor(async () => expect((await f.readRecord()).status).toBe("awaiting_original_model_result"));
		await reconcileAutomaticTaskNameBackfills();
		await vi.waitFor(() => expect(original).toHaveBeenCalled());
		original.mockResolvedValue(suggested);
		await vi.waitFor(async () => {
			await reconcileAutomaticTaskNameBackfills();
			expect((await f.readRecord()).status).toBe("completed");
		});
		expect((await f.readCard())?.title).toBe("[FIX]自动名称");
		expect(naming).toHaveBeenCalledOnce();
	});
});
