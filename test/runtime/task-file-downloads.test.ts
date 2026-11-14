import type * as nodeFsPromises from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTaskChatMessage } from "../../src/core/api-contract";
import { listTaskDirectory, openTaskRegularFile } from "../../src/task-file-downloads/task-file-access";
import { findLatestCompleteTaskPlan } from "../../src/task-file-downloads/task-main-session-plan";

const filesystemHooks = vi.hoisted(() => ({
	beforeStat: async (_path: string) => {},
	afterOpen: async () => {},
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof nodeFsPromises>();
	return {
		...actual,
		stat: (async (path, options) => {
			await filesystemHooks.beforeStat(String(path));
			return actual.stat(path, options);
		}) as typeof actual.stat,
		open: (async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			await filesystemHooks.afterOpen();
			return handle;
		}) as typeof actual.open,
	};
});

const directories: string[] = [];
afterEach(async () => {
	filesystemHooks.beforeStat = async () => {};
	filesystemHooks.afterOpen = async () => {};
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "kanban-task-file-download-"));
	directories.push(directory);
	const root = join(directory, "task-workspace");
	await mkdir(root);
	return { directory, root };
}

describe("任务原文件读取", () => {
	it.skipIf(process.platform === "win32")("拒绝特殊设备文件", async () => {
		await expect(openTaskRegularFile(null, "/dev/null")).rejects.toThrow(/普通文件/);
	});
	it("列出隐藏、未跟踪、空文件和目录，保持完整字节", async () => {
		const { root } = await fixture();
		await mkdir(join(root, "目录"));
		const files = new Map([
			["中文 文件.txt", Buffer.from("完整原文\n")],
			[".hidden", Buffer.alloc(0)],
			["untracked.bin", Buffer.from([0, 255, 13, 10])],
			["large.bin", Buffer.alloc(3 * 1024 * 1024, 123)],
		]);
		for (const [name, contents] of files) await writeFile(join(root, name), contents);
		const listing = await listTaskDirectory(root, "");
		expect(listing.entries.map((entry) => entry.name)).toEqual(expect.arrayContaining([...files.keys(), "目录"]));
		for (const [name, contents] of files) {
			const opened = await openTaskRegularFile(root, name);
			try {
				expect(await opened.handle.readFile()).toEqual(contents);
			} finally {
				await opened.handle.close();
			}
		}
	});
	it("拒绝越界、目录外链接、目录及消失文件，允许目录内链接", async () => {
		const { root, directory } = await fixture();
		await writeFile(join(directory, "secret"), "不可泄露");
		await writeFile(join(root, "inside"), "任务文件");
		await symlink(join(directory, "secret"), join(root, "outside-link"));
		await symlink(directory, join(root, "outside-directory"));
		await symlink(join(root, "inside"), join(root, "inside-link"));
		await mkdir(join(root, "inside-directory"));
		await symlink(join(root, "inside-directory"), join(root, "inside-directory-link"));
		expect(
			(await listTaskDirectory(root, "")).entries.find((entry) => entry.name === "inside-directory-link")?.kind,
		).toBe("directory");
		expect((await listTaskDirectory(root, "inside-directory-link")).entries).toEqual([]);
		for (const path of [
			"../secret",
			join(directory, "secret"),
			"outside-link",
			".",
			"missing",
			"outside-directory/secret",
		])
			await expect(openTaskRegularFile(root, path)).rejects.toThrow();
		await expect(listTaskDirectory(root, "outside-directory")).rejects.toThrow();
		const opened = await openTaskRegularFile(root, "inside-link");
		try {
			expect(await opened.handle.readFile("utf8")).toBe("任务文件");
		} finally {
			await opened.handle.close();
		}
	});
	it("无读取权限时返回明确错误", async () => {
		const { root } = await fixture();
		await writeFile(join(root, "private"), "不可读");
		await chmod(join(root, "private"), 0);
		await expect(openTaskRegularFile(root, "private")).rejects.toThrow(/权限/);
	});
	it("中间目录换链后即使恢复，也不返回目录外文件", async () => {
		const { root, directory } = await fixture();
		const insideDirectory = join(root, "inside-directory");
		const outside = join(directory, "outside");
		const saved = join(directory, "saved-directory");
		await mkdir(insideDirectory);
		await mkdir(outside);
		await writeFile(join(insideDirectory, "sentinel.txt"), "任务目录内的占位内容");
		await writeFile(join(outside, "sentinel.txt"), "目录外的隔离哨兵内容");
		let swapped = false;
		let restored = false;
		filesystemHooks.beforeStat = async (path) => {
			if (swapped || !path.endsWith(`${join("inside-directory", "sentinel.txt")}`)) return;
			swapped = true;
			await rename(insideDirectory, saved);
			await symlink(outside, insideDirectory);
		};
		filesystemHooks.afterOpen = async () => {
			await rm(insideDirectory);
			await rename(saved, insideDirectory);
			restored = true;
		};
		try {
			await expect(openTaskRegularFile(root, "inside-directory/sentinel.txt")).rejects.toThrow(/符号链接/);
		} finally {
			if (swapped && !restored) {
				await rm(insideDirectory, { force: true });
				await rename(saved, insideDirectory);
			}
		}
		expect(swapped).toBe(true);
		expect(await readFile(join(insideDirectory, "sentinel.txt"), "utf8")).toBe("任务目录内的占位内容");
	});
	it("中间目录换链后即使恢复，也不列出目录外文件名", async () => {
		const { root, directory } = await fixture();
		const insideDirectory = join(root, "inside-directory");
		const outside = join(directory, "outside");
		const saved = join(directory, "saved-directory");
		await mkdir(insideDirectory);
		await mkdir(outside);
		await writeFile(join(insideDirectory, "sentinel.txt"), "任务目录内的占位内容");
		await writeFile(join(insideDirectory, "a\nb.txt"), "换行文件名");
		await writeFile(join(outside, "outside-private-filename.md"), "目录外的隔离哨兵内容");
		let swapped = false;
		filesystemHooks.afterOpen = async () => {
			if (swapped) return;
			swapped = true;
			await rename(insideDirectory, saved);
			await symlink(outside, insideDirectory);
		};
		try {
			const listing = await listTaskDirectory(root, "inside-directory");
			const names = listing.entries.map((entry) => entry.name);
			expect(names).toEqual(expect.arrayContaining(["sentinel.txt", "a\nb.txt"]));
			expect(names).not.toContain("outside-private-filename.md");
		} finally {
			if (swapped) {
				await rm(insideDirectory, { force: true });
				await rename(saved, insideDirectory);
			}
		}
		expect(swapped).toBe(true);
		expect(await readFile(join(insideDirectory, "sentinel.txt"), "utf8")).toBe("任务目录内的占位内容");
	});
});

function message(
	id: string,
	content: string,
	role: RuntimeTaskChatMessage["role"] = "assistant",
	toolName?: string,
): RuntimeTaskChatMessage {
	return { id, role, content, createdAt: Number(id) || 1, meta: { toolName } };
}
describe("最近完整主会话 Plan", () => {
	it("选择最近完整内嵌计划，忽略用户引用和未完成新版本", () => {
		const result = findLatestCompleteTaskPlan(
			[
				message("1", "<proposed_plan>旧计划</proposed_plan>"),
				message("2", "<proposed_plan>新计划</proposed_plan>"),
				message("3", "<proposed_plan>未完成计划，文件在 `.plan/draft.md`"),
				message("4", "<proposed_plan>用户引用</proposed_plan>", "user"),
			],
			"/task",
		);
		expect(result?.markdown).toBe("新计划");
	});
	it("同一版本多个文件保留候选，不混入更早版本", () => {
		const result = findLatestCompleteTaskPlan(
			[
				message("1", "计划在 `.plan/old.md`"),
				message("2", "计划：[方案甲](.plan/方案甲.md) 和 [方案乙](.plan/方案乙.md)"),
			],
			"/task",
		);
		expect(result?.filePaths).toEqual(["/task/.plan/方案甲.md", "/task/.plan/方案乙.md"]);
	});
	it("Claude ExitPlanMode 的完整正文与明确文件来源", () => {
		const result = findLatestCompleteTaskPlan(
			[
				message(
					"1",
					JSON.stringify({ plan: "# 完整计划", file_path: "/home/.claude/plans/中文.md" }),
					"tool",
					"ExitPlanMode",
				),
			],
			"/task",
		);
		expect(result?.markdown).toBe("# 完整计划");
		expect(result?.filePaths).toEqual(["/home/.claude/plans/中文.md"]);
	});
	it("无明确计划时不把普通正文当计划", () => {
		expect(findLatestCompleteTaskPlan([message("1", "这里没有计划")], "/task")).toBeNull();
	});
	it("拒绝用 .. 把计划目录引用解析到目录外", () => {
		expect(
			findLatestCompleteTaskPlan([message("1", "计划：请看 [笔记](.plan/../../secret-dir/notes.md)")], "/task"),
		).toBeNull();
		expect(findLatestCompleteTaskPlan([message("1", "请看 [x](docs/plans/../../../secret.md)")], "/task")).toBeNull();
		const escaped = findLatestCompleteTaskPlan(
			[
				message(
					"1",
					JSON.stringify({ plan: "# 完整计划", file_path: "/home/.claude/plans/../../../secret.md" }),
					"tool",
					"ExitPlanMode",
				),
			],
			"/task",
		);
		expect(escaped?.markdown).toBe("# 完整计划");
		expect(escaped?.filePaths).toEqual([]);
	});
	it("普通计划目录写入不覆盖已有完整计划", () => {
		const result = findLatestCompleteTaskPlan(
			[
				message("1", "<proposed_plan>完整的实施方案</proposed_plan>"),
				message(
					"2",
					JSON.stringify({
						file_path: ".plan/docs/implementation-research-notes.md",
						content: "刚才发现一个可疑日志，后续继续调查。",
					}),
					"tool",
					"Write",
				),
			],
			"/task",
		);
		expect(result?.messageId).toBe("1");
		expect(result?.markdown).toBe("完整的实施方案");
	});
	it("明确关联的计划文件不必位于 .plan 或 plans 目录", () => {
		const result = findLatestCompleteTaskPlan(
			[
				message("1", "<proposed_plan>旧的完整计划</proposed_plan>"),
				message("2", "本任务新版完整计划见 [完整计划](docs/custom.md)"),
			],
			"/task",
		);
		expect(result?.messageId).toBe("2");
		expect(result?.markdown).toBeNull();
		expect(result?.filePaths).toEqual(["/task/docs/custom.md"]);
		expect(
			findLatestCompleteTaskPlan([message("1", "计划文件已经写入 `docs/implementation-plan.md`。")], "/task")
				?.filePaths,
		).toEqual(["/task/docs/implementation-plan.md"]);
	});
});
