// 把浏览器 localStorage 里的 Prompt Library 读出来、整理成一条合并意图的载荷。纯函数，不发请求。
//
// 去重与时间戳收敛在**服务端**做（见 src/state/prompt-library-store.ts 的
// withBrowserLocalStoragePromptsMerged）：那里才拿得到「服务端此刻有什么」，也才有文件锁保证多个
// origin 同时迁移不互相覆盖。这里只负责把三个 localStorage 键读成一份带桶标注的扁平列表。
//
// **不删本地数据**：它既是回退备份，也因为合并按「桶 + 正文」去重而天然幂等，留着不会造成重复。

import type { PromptLibraryScope, WorkspacePromptLibraryMutation } from "@/runtime/types";
import { LocalStorageKey, readLocalStorageItem } from "@/storage/local-storage-store";

type MergeMutation = Extract<
	WorkspacePromptLibraryMutation,
	{ kind: "merge_prompts_migrated_from_browser_local_storage" }
>;
export type PromptMigratedFromBrowserLocalStorage = MergeMutation["prompts"][number];

function parseJsonOrNull(rawText: string | null): unknown {
	if (rawText === null) {
		return null;
	}
	try {
		return JSON.parse(rawText);
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读一条旧条目。
 *
 * 时间戳缺失或不是有限数时补 0 而不是补「现在」：这些是历史数据，盖上当前时间会让所有模板的创建时间
 * 变成升级那一刻；而 0 在服务端的 `Math.min(createdAt)` 收敛里表现为「最早」，正好符合「它比服务端
 * 那份更老」的事实。正文为空的条目直接丢弃——空模板对用户没有任何价值，还会占满面板。
 */
function readStoredPrompt(
	value: unknown,
	fallbackScope: PromptLibraryScope,
	taskId: string | null,
): PromptMigratedFromBrowserLocalStorage | null {
	if (!isRecord(value)) {
		return null;
	}
	const id = typeof value.id === "string" ? value.id : null;
	const text = typeof value.text === "string" ? value.text : null;
	if (!id || !text) {
		return null;
	}
	const scope =
		value.scope === "global" || value.scope === "repo" || value.scope === "task" ? value.scope : fallbackScope;
	if (scope === "task" && !taskId) {
		// scope 为 task 却不知道属于哪个任务：契约会拒绝整条意图，所以在这里就丢掉它，
		// 不能让一条脏数据把整份迁移带崩。
		return null;
	}
	const updatedAt = typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0;
	const createdAt =
		typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : updatedAt;
	return {
		id,
		text,
		scope,
		...(scope === "task" ? { taskId } : {}),
		createdAt,
		updatedAt,
	};
}

function readPromptList(
	value: unknown,
	fallbackScope: PromptLibraryScope,
	taskId: string | null,
): PromptMigratedFromBrowserLocalStorage[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((entry) => {
		const prompt = readStoredPrompt(entry, fallbackScope, taskId);
		return prompt ? [prompt] : [];
	});
}

/**
 * 读出这台浏览器里全部旧 prompt，按桶标注好。
 *
 * `projectId` 决定 by-project 桶取哪一份——旧的 by-project 键是 `projectId → 条目[]`，而服务端的
 * repo 桶是**每个 workspace 一份文件**，所以只搬当前这个项目那一份，别的项目等它自己被打开时再搬。
 */
export function readPromptLibraryMigrationPayloadFromBrowserLocalStorage(
	projectId: string,
): PromptMigratedFromBrowserLocalStorage[] {
	const globalPrompts = readPromptList(
		parseJsonOrNull(readLocalStorageItem(LocalStorageKey.PromptLibraryGlobal)),
		"global",
		null,
	);

	const byProject = parseJsonOrNull(readLocalStorageItem(LocalStorageKey.PromptLibraryByProject));
	const repoPrompts = isRecord(byProject) ? readPromptList(byProject[projectId], "repo", null) : [];

	const byTask = parseJsonOrNull(readLocalStorageItem(LocalStorageKey.PromptLibraryByTask));
	const taskPrompts = isRecord(byTask)
		? Object.entries(byTask).flatMap(([taskId, entries]) => readPromptList(entries, "task", taskId))
		: [];

	return [...globalPrompts, ...repoPrompts, ...taskPrompts];
}

const PROMPT_LIBRARY_MIGRATION_MARKER_STORAGE_KEY = LocalStorageKey.PromptLibraryUploadedToServerAt;

/** 已经迁移过的 workspaceId → 迁移完成时刻（epoch ms）。 */
function readMigrationMarkers(): Record<string, number> {
	const parsed = parseJsonOrNull(readLocalStorageItem(PROMPT_LIBRARY_MIGRATION_MARKER_STORAGE_KEY));
	if (!isRecord(parsed)) {
		return {};
	}
	const markers: Record<string, number> = {};
	for (const [workspaceId, value] of Object.entries(parsed)) {
		if (typeof value === "number" && Number.isFinite(value)) {
			markers[workspaceId] = value;
		}
	}
	return markers;
}

export function hasUploadedPromptLibraryToServer(workspaceId: string): boolean {
	return readMigrationMarkers()[workspaceId] !== undefined;
}

/**
 * 标记这个 workspace 已迁移。
 *
 * 标记只是省掉每次挂载都重发一份载荷的优化，**不是**正确性依赖：服务端的合并按「桶 + 正文」去重，
 * 重复迁移不会造出重复条目。所以标记丢了最多多发一次请求，没有数据风险。
 */
export function buildPromptLibraryMigrationMarkersWithWorkspaceMarked(
	workspaceId: string,
	completedAtEpochMs: number,
): Record<string, number> {
	return { ...readMigrationMarkers(), [workspaceId]: completedAtEpochMs };
}

export { PROMPT_LIBRARY_MIGRATION_MARKER_STORAGE_KEY };
