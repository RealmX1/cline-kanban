import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { createTaskFileDownloadService } from "../../src/task-file-downloads/task-file-download-service";

const { loadState, resolveCwd } = vi.hoisted(() => ({ loadState: vi.fn(), resolveCwd: vi.fn() }));
vi.mock("../../src/state/workspace-state", () => ({
	loadPersistedWorkspaceStateById: loadState,
	getTaskWorktreesHomePath: () => "/task-worktrees",
}));
vi.mock("../../src/workspace/task-worktree", () => ({
	resolveTaskCwd: resolveCwd,
	getTaskWorkspacePathInfo: async () => ({ path: await resolveCwd() }),
}));
const directories: string[] = [];
afterEach(async () => {
	vi.resetAllMocks();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "kanban-task-download-service-"));
	directories.push(directory);
	const scope = { workspaceId: "workspace-a", workspacePath: directory };
	const card: RuntimeBoardCard = {
		id: "same-id",
		title: "下载测试",
		prompt: "需求",
		baseRef: "main",
		startInPlanMode: false,
		worktreeMode: "inplace",
		createdAt: 10,
		updatedAt: 10,
		mainTaskConversationSessionId: "new-main",
	};
	const summary: RuntimeTaskSessionSummary = {
		taskId: "new-main",
		workspacePath: directory,
		agentId: "codex",
		state: "awaiting_review",
		turnOwner: "user",
		liveness: "exited",
		userTurnKind: "review",
		pid: null,
		startedAt: 1,
		updatedAt: 2,
		lastOutputAt: 2,
		reviewReason: null,
		exitCode: 0,
		lastHookAt: null,
		latestHookActivity: null,
		taskConversationSessionMetadata: {
			workspaceTaskId: "same-id",
			taskConversationSessionRole: "main",
			taskConversationSessionContextSource: "started_from_scratch",
			parentTaskConversationSessionId: null,
			mainSessionOriginTurnNumber: null,
			mainSessionOriginUserMessagePreview: null,
			latestUserMessagePreview: null,
		},
	};
	loadState.mockImplementation(async (workspaceId) => ({
		board: { columns: [{ cards: workspaceId === scope.workspaceId ? [card] : [{ ...card, createdAt: 20 }] }] },
		sessions: { "new-main": summary },
	}));
	resolveCwd.mockResolvedValue(directory);
	const readHistory = vi.fn().mockResolvedValue({
		availability: "available",
		messages: [
			{ id: "1", role: "assistant", content: "<proposed_plan># 当前主会话计划</proposed_plan>", createdAt: 1 },
		],
		nextCursor: null,
		notice: null,
	});
	const service = createTaskFileDownloadService(readHistory);
	const input = { taskId: card.id, expectedTaskIncarnationCreatedAtEpochMs: 10 };
	return { directory, scope, card, summary, readHistory, service, input };
}
it("拒绝过期 incarnation 和跨项目同号身份，且读取不创建工作树", async () => {
	const f = await fixture();
	await expect(
		f.service.listDirectory(f.scope, { ...f.input, expectedTaskIncarnationCreatedAtEpochMs: 9, path: "" }),
	).rejects.toThrow(/身份/);
	await expect(
		f.service.listDirectory({ ...f.scope, workspaceId: "workspace-b" }, { ...f.input, path: "" }),
	).rejects.toThrow(/身份/);
	await f.service.listDirectory(f.scope, { ...f.input, path: "" });
	expect(resolveCwd).toHaveBeenCalledWith(expect.objectContaining({ ensure: false, taskId: f.input.taskId }));
});
it("只读取当前绑定的主会话，内嵌计划导出 Markdown，换主后旧候选失效", async () => {
	const f = await fixture();
	const plan = await f.service.getMainSessionPlan(f.scope, f.input);
	expect(f.readHistory).toHaveBeenCalledWith(
		f.scope,
		expect.objectContaining({ taskConversationSessionId: "new-main" }),
	);
	const candidateId = plan.candidates[0]?.candidateId;
	expect(await f.service.openDownload(f.scope, { ...f.input, source: "main_session_plan", candidateId })).toEqual({
		markdown: "# 当前主会话计划",
		fileName: "same-id-main-session-plan.md",
	});
	f.card.mainTaskConversationSessionId = "another-main";
	await expect(
		f.service.openDownload(f.scope, { ...f.input, source: "main_session_plan", candidateId }),
	).rejects.toThrow(/来源/);
});
it("Claude 计划文件保留原字节，文件缺失时仍可导出已核实正文", async () => {
	const f = await fixture();
	const path = join(f.directory, ".claude/plans/中文 计划.md");
	await mkdir(join(f.directory, ".claude/plans"), { recursive: true });
	await writeFile(path, "# 完整计划\r\n");
	f.readHistory.mockResolvedValue({
		availability: "available",
		messages: [
			{
				id: "2",
				role: "tool",
				content: JSON.stringify({ plan: "# 完整计划", file_path: path }),
				meta: { toolName: "ExitPlanMode" },
				createdAt: 2,
			},
		],
		nextCursor: null,
		notice: null,
	});
	const plan = await f.service.getMainSessionPlan(f.scope, f.input);
	expect(plan.candidates[0]?.sourceKind).toBe("file");
	const download = await f.service.openDownload(f.scope, {
		...f.input,
		source: "main_session_plan",
		candidateId: plan.candidates[0]?.candidateId,
	});
	if (!("handle" in download)) throw new Error("预期原文件");
	try {
		expect(await download.handle.readFile()).toEqual(await readFile(path));
	} finally {
		await download.handle.close();
	}
	await rm(path);
	expect((await f.service.getMainSessionPlan(f.scope, f.input)).candidates[0]?.sourceKind).toBe("markdown");
});
it("正文核验后文件被替换时下载已核实 Markdown，不返回新字节", async () => {
	const f = await fixture();
	const path = join(f.directory, ".plan/完整计划.md");
	await mkdir(join(f.directory, ".plan"), { recursive: true });
	await writeFile(path, "# 已核实完整计划\n");
	f.readHistory.mockResolvedValue({
		availability: "available",
		messages: [
			{
				id: "2",
				role: "assistant",
				content: `<proposed_plan># 已核实完整计划</proposed_plan>\n计划文件：\`${path}\``,
				createdAt: 2,
			},
		],
		nextCursor: null,
		notice: null,
	});
	let reads = 0;
	loadState.mockImplementation(async (workspaceId: string) => {
		reads += 1;
		if (reads === 4) await writeFile(path, "# 在核验后替换的新文件\n");
		return {
			board: {
				columns: [{ cards: workspaceId === f.scope.workspaceId ? [f.card] : [{ ...f.card, createdAt: 20 }] }],
			},
			sessions: { "new-main": f.summary },
		};
	});
	const plan = await f.service.getMainSessionPlan(f.scope, f.input);
	expect(plan.candidates[0]?.sourceKind).toBe("file");
	const download = await f.service.openDownload(f.scope, {
		...f.input,
		source: "main_session_plan",
		candidateId: plan.candidates[0]?.candidateId,
	});
	expect(download).toEqual({ markdown: "# 已核实完整计划", fileName: "same-id-main-session-plan.md" });
	expect(await readFile(path, "utf8")).toBe("# 在核验后替换的新文件\n");
});
it("只读补证不能成为可下载的主会话 Plan", async () => {
	const f = await fixture();
	f.readHistory.mockResolvedValue({
		availability: "available",
		messages: [{ id: "1", role: "assistant", content: "<proposed_plan># 只读计划</proposed_plan>", createdAt: 1 }],
		nextCursor: null,
		notice: "已核对任务工作树、原生记录时间和精确首提示词，仅供阅读。",
		nativeHistorySource: "verified_read_only",
	});
	const plan = await f.service.getMainSessionPlan(f.scope, f.input);
	expect(plan.availability).toBe("unknown");
	expect(plan.candidates).toEqual([]);
	expect(plan.notice).toContain("只读补证");
});
it("历史不可读、读取预算不足和无计划状态分别保留", async () => {
	const f = await fixture();
	f.readHistory.mockResolvedValue({
		availability: "unavailable",
		messages: [],
		nextCursor: null,
		notice: "转录暂不可读",
	});
	expect((await f.service.getMainSessionPlan(f.scope, f.input)).availability).toBe("unknown");
	f.readHistory.mockResolvedValue({ availability: "available", messages: [], nextCursor: "repeat", notice: null });
	expect((await f.service.getMainSessionPlan(f.scope, f.input)).availability).toBe("unknown");
	f.readHistory.mockResolvedValue({ availability: "available", messages: [], nextCursor: null, notice: null });
	expect((await f.service.getMainSessionPlan(f.scope, f.input)).availability).toBe("none");
});
