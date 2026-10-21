// Prompt Library 面板的控制器。真相源在**服务端**（~/.cline/kanban[/workspaces/<id>]/prompt-library.json）。
//
// 为什么不再是 localStorage：localStorage 是 per-origin 的（`web:dev` 固定 4173、`dev:full` 每次挑一个
// 空闲端口），换个端口就是全新一份库；而且终端 Ctrl+S 暂存与 W1 争用抢占都由**运行时**发起写入，
// 浏览器侧的库根本接不住它们——那两条特性写进去的条目在旧实现里对面板是不可见的。
//
// ## 写操作是意图，不是整份 PUT
//
// 多个标签页 + 运行时自己会并发写同一个库。整份 PUT 的 last-write-wins 会静默抹掉「另一个标签页刚加的
// 条目」，所以这里只发意图（新增/改文/删除/换 scope），服务端在文件锁内读-改-写。
//
// ## 正文编辑必须本地回显 + 去抖落盘
//
// 面板的 textarea 每次击键都会调 `updatePromptText`。逐次击键发一趟 tRPC + 跨进程文件锁是不可接受的
// （既卡输入又把库文件锁成热点）。所以正文编辑先进按项目隔离的本地正文缓冲立即回显，静默
// 一段时间后才落盘；组件卸载时强制冲刷，避免「打完字直接切走」丢掉最后一段。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import { subscribeToPromptLibraryInvalidations } from "@/runtime/prompt-library-invalidation-events";
import {
	buildPromptLibraryMigrationMarkersWithWorkspaceMarked,
	hasUploadedPromptLibraryToServer,
	PROMPT_LIBRARY_MIGRATION_MARKER_STORAGE_KEY,
	readPromptLibraryMigrationPayloadFromBrowserLocalStorage,
} from "@/runtime/prompt-library-migration-from-browser-local-storage";
import {
	EMPTY_WORKSPACE_PROMPT_LIBRARY_SNAPSHOT,
	fetchWorkspacePromptLibrary,
	mutateWorkspacePromptLibrary,
} from "@/runtime/prompt-library-query";
import type {
	PromptLibraryScope,
	StoredPromptLibraryEntry,
	WorkspacePromptLibraryMutation,
	WorkspacePromptLibrarySnapshot,
} from "@/runtime/types";
import { writeLocalStorageItem } from "@/storage/local-storage-store";

/** 正文停止变动多久后才落盘。够短到「切走前基本已存」，够长到一句话不会发十几趟请求。 */
const PROMPT_TEXT_PERSIST_DEBOUNCE_MS = 600;

export type PromptScope = PromptLibraryScope;
export type StoredPrompt = StoredPromptLibraryEntry;

interface PendingPromptTextEdit {
	text: string;
	taskId: string;
}

type PendingPromptTextEditsByProjectId = Record<string, Record<string, PendingPromptTextEdit>>;

export interface PromptLibraryController {
	prompts: StoredPrompt[];
	reusableCommands: StoredPrompt[];
	/**
	 * 归属的任务已经不在看板上的 task-scoped 条目。
	 *
	 * 为什么有这种东西：prompt 是用户攒的**资产**，刻意不随任务删除而毁（与草稿相反，见
	 * src/state/task-edit-draft-store.ts 顶部那段对比）。代价就是任务没了之后，它名下的条目对
	 * **任何**任务视角都不再可见——`resolveVisiblePrompts` 只取 `taskScopedPromptsByTaskId[taskId]`，
	 * 而那个 taskId 再也不会被打开。不给回收入口的话，「不随任务删除而毁」保住的只是磁盘上的字节。
	 */
	orphanedPrompts: StoredPrompt[];
	addPrompt: () => string;
	updatePromptText: (id: string, text: string) => void;
	removePrompt: (id: string) => void;
	setPromptScope: (id: string, scope: PromptScope) => void;
	/** 把一条孤儿条目认领到当前任务名下（它随即出现在上面的 prompts 里）。 */
	claimOrphanedPrompt: (id: string) => void;
	setPromptUsageStatus: (id: string, isUsed: boolean) => void;
	convertPromptToReusableCommand: (id: string, scope: "repo" | "global") => void;
}

export function comparePromptLibraryEntriesByUsageThenTextEditRecency(left: StoredPrompt, right: StoredPrompt): number {
	return (
		Number(left.draftUsage?.markedUsedAtEpochMs != null) - Number(right.draftUsage?.markedUsedAtEpochMs != null) ||
		(right.textLastEditedAtEpochMs ?? right.updatedAt) - (left.textLastEditedAtEpochMs ?? left.updatedAt)
	);
}

/**
 * 挑出归属任务已不在看板上的 task-scoped 条目。
 *
 * 判据由**调用方注入**而不是存进库里：库文件只按 taskId 分桶，不知道任务是否还存在；而「任务是否
 * 还在看板上」会变（trash 里的任务还能恢复、任务也可能在另一个标签页被删掉）。存一个 `orphaned: true`
 * 标记就等于把一个会过期的判断固化进用户资产里，任务一恢复它就开始撒谎。
 *
 * `taskIdsOnBoard` 为 null = 调用方此刻还不知道看板上有哪些任务（首屏未加载）。此时**一条都不标**：
 * 把「还不知道」当成「都不存在」，会让整个库在加载完成前的一瞬间全变成孤儿。
 */
export function resolveOrphanedPrompts(
	snapshot: WorkspacePromptLibrarySnapshot,
	taskIdsOnBoard: ReadonlySet<string> | null,
): StoredPrompt[] {
	if (taskIdsOnBoard === null) {
		return [];
	}
	return Object.entries(snapshot.taskScopedPromptsByTaskId).flatMap(([taskId, prompts]) =>
		taskIdsOnBoard.has(taskId) ? [] : prompts,
	);
}

/** 某个任务视角下可见的条目：全局组在前，然后是本仓库组，最后是这个任务自己的组。 */
export function resolveVisiblePrompts(snapshot: WorkspacePromptLibrarySnapshot, taskId: string): StoredPrompt[] {
	return [
		...snapshot.globalScopedPrompts,
		...snapshot.repoScopedPrompts,
		...(snapshot.taskScopedPromptsByTaskId[taskId] ?? []),
	];
}

function createPromptId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 乐观地把一条新建的空条目插进快照。
 *
 * 没有它的话，从点「新增」到服务端 ack 之间列表里没有这一行，面板那个「新增后自动聚焦」的效果就会
 * 落空（要聚焦的 DOM 节点还不存在）。ack 回来的快照会整份替换掉这份乐观值。
 */
function withOptimisticallyCreatedPrompt(
	snapshot: WorkspacePromptLibrarySnapshot,
	promptId: string,
	taskId: string,
	createdAtEpochMs: number,
): WorkspacePromptLibrarySnapshot {
	const created: StoredPrompt = {
		id: promptId,
		text: "",
		scope: "task",
		origin: "manual",
		createdAt: createdAtEpochMs,
		updatedAt: createdAtEpochMs,
	};
	return {
		...snapshot,
		taskScopedPromptsByTaskId: {
			...snapshot.taskScopedPromptsByTaskId,
			[taskId]: [...(snapshot.taskScopedPromptsByTaskId[taskId] ?? []), created],
		},
	};
}

export function usePromptLibrary(
	taskId: string,
	projectId: string,
	taskIdsOnBoard: ReadonlySet<string> | null = null,
): PromptLibraryController {
	const [projectLibrarySnapshot, setProjectLibrarySnapshot] = useState({
		projectId,
		snapshot: EMPTY_WORKSPACE_PROMPT_LIBRARY_SNAPSHOT,
	});
	// 切换项目后的首帧也不能显示旧库；新项目读失败时仍保持空列表。
	const librarySnapshot =
		projectLibrarySnapshot.projectId === projectId
			? projectLibrarySnapshot.snapshot
			: EMPTY_WORKSPACE_PROMPT_LIBRARY_SNAPSHOT;
	// 待落盘正文按项目隔离，并保留编辑时的任务归属；切走后的失败请求仍可在原项目重试。
	const [pendingPromptTextEditsByProjectId, setPendingPromptTextEditsByProjectId] =
		useState<PendingPromptTextEditsByProjectId>({});
	const currentProjectPendingPromptTextEditsByPromptId = pendingPromptTextEditsByProjectId[projectId] ?? {};

	// 去抖与卸载冲刷读最新缓冲，但只能读取各自闭包所属项目的那一桶。
	const pendingPromptTextEditsByProjectIdRef = useRef(pendingPromptTextEditsByProjectId);
	pendingPromptTextEditsByProjectIdRef.current = pendingPromptTextEditsByProjectId;
	const persistDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const activeProjectIdRef = useRef(projectId);
	activeProjectIdRef.current = projectId;
	const snapshotRequestSequenceRef = useRef(0);
	const latestAppliedSnapshotSequenceRef = useRef(0);
	const successfulMutationGenerationByProjectIdRef = useRef(new Map<string, number>());
	const applyServerSnapshot = useCallback(
		(snapshot: WorkspacePromptLibrarySnapshot, requestSequence: number, requestedProjectId: string) => {
			if (activeProjectIdRef.current === requestedProjectId) {
				if (requestSequence < latestAppliedSnapshotSequenceRef.current) return;
				latestAppliedSnapshotSequenceRef.current = requestSequence;
				setProjectLibrarySnapshot({ projectId: requestedProjectId, snapshot });
			}
			// 当前项目只在即将显示的快照确认正文时清覆盖；旧项目的成功响应也要清理它自己的缓冲。
			const serverTextByPromptId = new Map(
				[
					...snapshot.globalScopedPrompts,
					...snapshot.repoScopedPrompts,
					...Object.values(snapshot.taskScopedPromptsByTaskId).flat(),
				].map((entry) => [entry.id, entry.text]),
			);
			setPendingPromptTextEditsByProjectId((current) => {
				const projectEdits = current[requestedProjectId] ?? {};
				const remaining = Object.fromEntries(
					Object.entries(projectEdits).filter(([id, edit]) => serverTextByPromptId.get(id) !== edit.text),
				);
				return Object.keys(remaining).length === Object.keys(projectEdits).length
					? current
					: { ...current, [requestedProjectId]: remaining };
			});
		},
		[],
	);

	const refreshProjectLibrarySnapshot = useCallback(
		async function refreshProjectSnapshotUntilNoLocalWriteCompletesDuringRead(
			requestedProjectId: string,
		): Promise<WorkspacePromptLibrarySnapshot | null> {
			const requestSequence = ++snapshotRequestSequenceRef.current;
			const successfulMutationGenerationAtReadStart =
				successfulMutationGenerationByProjectIdRef.current.get(requestedProjectId) ?? 0;
			const snapshot = await fetchWorkspacePromptLibrary(requestedProjectId).catch(() => null);
			if (activeProjectIdRef.current !== requestedProjectId) return null;
			if (
				successfulMutationGenerationAtReadStart !==
				(successfulMutationGenerationByProjectIdRef.current.get(requestedProjectId) ?? 0)
			) {
				// 这趟查询可能在写入前读到旧库；成功写入之后再读一次，不把旧正文或状态盖回来。
				return refreshProjectSnapshotUntilNoLocalWriteCompletesDuringRead(requestedProjectId);
			}
			if (snapshot) applyServerSnapshot(snapshot, requestSequence, requestedProjectId);
			return snapshot;
		},
		[applyServerSnapshot],
	);

	// 每个调用点都是 fire-and-forget（用户点一下就走，没人等这个 promise），所以异常必须**在这里**吞掉：
	// 让它漏出去就是一条 unhandled rejection——在生产里会被 Sentry 当成崩溃上报，在测试里会污染别的用例。
	// 对新增/删除/换 scope 这几条路径，吞掉就够了：写失败时服务端快照不变，界面继续显示上一次的真相，
	// 用户再点一次即可。
	//
	// 但吞掉异常**不等于**可以当成写成功。正文冲刷要靠「到底落盘了没有」来决定那份待落盘正文能不能清
	// （清早了用户刚打的字就凭空消失），所以这里把两种失败形态——抛异常、以及服务端回 ok:false 让
	// `mutateWorkspacePromptLibrary` 返回 null——统一折成 `false` 如实报出去，而不是只吞不报。
	const applyMutation = useCallback(
		async (mutation: WorkspacePromptLibraryMutation): Promise<boolean> => {
			const requestSequence = ++snapshotRequestSequenceRef.current;
			const requestedProjectId = projectId;
			const nextSnapshot = await mutateWorkspacePromptLibrary(requestedProjectId, mutation).catch(() => null);
			if (nextSnapshot === null) {
				return false;
			}
			successfulMutationGenerationByProjectIdRef.current.set(
				requestedProjectId,
				(successfulMutationGenerationByProjectIdRef.current.get(requestedProjectId) ?? 0) + 1,
			);
			applyServerSnapshot(nextSnapshot, requestSequence, requestedProjectId);
			if (
				activeProjectIdRef.current === requestedProjectId &&
				requestSequence < latestAppliedSnapshotSequenceRef.current
			) {
				// 较晚发出的查询可能先读到旧库，也可能读到外部的新状态；保留当前显示并在写入后重读。
				void refreshProjectLibrarySnapshot(requestedProjectId);
			}
			return true;
		},
		[applyServerSnapshot, projectId, refreshProjectLibrarySnapshot],
	);

	const flushPendingPromptTextEdits = useCallback((): void => {
		const pendingEdits = pendingPromptTextEditsByProjectIdRef.current[projectId] ?? {};
		const pendingPromptIds = Object.keys(pendingEdits);
		if (pendingPromptIds.length === 0) {
			return;
		}
		for (const promptId of pendingPromptIds) {
			const pendingEdit = pendingEdits[promptId];
			if (pendingEdit === undefined) {
				continue;
			}
			// 这里的 `scope`/`taskId` 只在「服务端找不到这个 id、要新建」时才生效——upsert_prompt 对
			// **已存在**的条目只改正文、绝不动它所在的桶（见 prompt-library-store 的意图语义）。所以给
			// 全局/仓库作用域的条目改文也不会把它拽进当前任务。仅有的落差是：某条目在两次击键之间被
			// 别处删掉时，这次冲刷会把它按 task scope 重建出来。可接受——重建回来的是用户刚打的字，
			// 而反过来（丢掉）才是真损失。
			void applyMutation({
				kind: "upsert_prompt",
				promptId,
				text: pendingEdit.text,
				scope: "task",
				taskId: pendingEdit.taskId,
			});
		}
	}, [applyMutation, projectId]);

	// 载入服务端库，并把这台浏览器里的历史条目合并上去。
	useEffect(() => {
		let isCurrent = true;
		void (async () => {
			const snapshot = await refreshProjectLibrarySnapshot(projectId);
			if (!isCurrent) {
				return;
			}
			// 读不出来（库文件损坏等）时保持空列表，且**不做迁移**——把损坏当空库会再叠一份重复数据。
			if (snapshot === null) {
				return;
			}
			if (hasUploadedPromptLibraryToServer(projectId)) {
				return;
			}
			const promptsToMigrate = readPromptLibraryMigrationPayloadFromBrowserLocalStorage(projectId);
			if (promptsToMigrate.length === 0) {
				return;
			}
			const migrationSucceeded = await applyMutation({
				kind: "merge_prompts_migrated_from_browser_local_storage",
				prompts: promptsToMigrate,
			});
			if (!isCurrent || !migrationSucceeded) {
				// 迁移失败就不打标记，下次挂载再试。合并是幂等的，重试不会造出重复条目。
				return;
			}
			writeLocalStorageItem(
				PROMPT_LIBRARY_MIGRATION_MARKER_STORAGE_KEY,
				JSON.stringify(buildPromptLibraryMigrationMarkersWithWorkspaceMarked(projectId, Date.now())),
			);
		})();
		return () => {
			isCurrent = false;
		};
	}, [applyMutation, projectId, refreshProjectLibrarySnapshot]);

	useEffect(
		() =>
			subscribeToPromptLibraryInvalidations((changedWorkspaceId) => {
				if (changedWorkspaceId !== null && changedWorkspaceId !== projectId) return;
				void refreshProjectLibrarySnapshot(projectId);
			}),
		[projectId, refreshProjectLibrarySnapshot],
	);

	// 卸载时冲刷：面板经常是「打完字直接切走」，等去抖到点已经来不及了。
	useEffect(() => {
		return () => {
			if (persistDebounceTimerRef.current !== null) {
				clearTimeout(persistDebounceTimerRef.current);
				persistDebounceTimerRef.current = null;
			}
			flushPendingPromptTextEdits();
		};
	}, [flushPendingPromptTextEdits]);

	const visibleEntries = useMemo(() => {
		const visiblePrompts = resolveVisiblePrompts(librarySnapshot, taskId);
		if (Object.keys(currentProjectPendingPromptTextEditsByPromptId).length === 0) {
			return visiblePrompts.sort(comparePromptLibraryEntriesByUsageThenTextEditRecency);
		}
		return visiblePrompts
			.map((prompt) => {
				const locallyEditedText = currentProjectPendingPromptTextEditsByPromptId[prompt.id]?.text;
				return locallyEditedText === undefined || locallyEditedText === prompt.text
					? prompt
					: { ...prompt, text: locallyEditedText, draftUsage: undefined };
			})
			.sort(comparePromptLibraryEntriesByUsageThenTextEditRecency);
	}, [librarySnapshot, currentProjectPendingPromptTextEditsByPromptId, taskId]);

	const addPrompt = useCallback((): string => {
		const promptId = createPromptId();
		setProjectLibrarySnapshot((current) => ({
			projectId,
			snapshot: withOptimisticallyCreatedPrompt(
				current.projectId === projectId ? current.snapshot : EMPTY_WORKSPACE_PROMPT_LIBRARY_SNAPSHOT,
				promptId,
				taskId,
				Date.now(),
			),
		}));
		void applyMutation({ kind: "upsert_prompt", promptId, text: "", scope: "task", taskId, origin: "manual" });
		return promptId;
	}, [applyMutation, projectId, taskId]);

	const updatePromptText = useCallback(
		(promptId: string, text: string) => {
			setPendingPromptTextEditsByProjectId((current) => ({
				...current,
				[projectId]: { ...current[projectId], [promptId]: { text, taskId } },
			}));
			if (persistDebounceTimerRef.current !== null) {
				clearTimeout(persistDebounceTimerRef.current);
			}
			persistDebounceTimerRef.current = setTimeout(() => {
				persistDebounceTimerRef.current = null;
				flushPendingPromptTextEdits();
			}, PROMPT_TEXT_PERSIST_DEBOUNCE_MS);
		},
		[flushPendingPromptTextEdits, projectId, taskId],
	);

	const removePrompt = useCallback(
		(promptId: string) => {
			// 连本地那份待落盘正文一起丢掉：留着它会让这条被删的条目在下一次冲刷时又被 upsert 回来。
			setPendingPromptTextEditsByProjectId((current) => {
				const { [promptId]: _removed, ...remaining } = current[projectId] ?? {};
				return { ...current, [projectId]: remaining };
			});
			void applyMutation({ kind: "remove_prompt", promptId });
		},
		[applyMutation, projectId],
	);

	const setPromptScope = useCallback(
		(promptId: string, scope: PromptScope) => {
			void applyMutation({ kind: "set_prompt_scope", promptId, scope, taskId: scope === "task" ? taskId : null });
		},
		[applyMutation, taskId],
	);

	// 认领 = 把这条搬到当前任务的桶里。复用 set_prompt_scope 而不是新开一条意图：搬桶正是它的语义，
	// 而多一条做同一件事的意图就多一处并发时可能与它互相覆盖的写入。
	const claimOrphanedPrompt = useCallback(
		(promptId: string) => {
			void applyMutation({ kind: "set_prompt_scope", promptId, scope: "task", taskId });
		},
		[applyMutation, taskId],
	);
	const performPromptMutationAfterFlushingItsText = useCallback(
		async (promptId: string, mutation: WorkspacePromptLibraryMutation) => {
			const pendingEdit = pendingPromptTextEditsByProjectIdRef.current[projectId]?.[promptId];
			if (pendingEdit !== undefined) {
				if (
					!(await applyMutation({
						kind: "upsert_prompt",
						promptId,
						text: pendingEdit.text,
						scope: "task",
						taskId: pendingEdit.taskId,
					}))
				) {
					showAppToast({ intent: "danger", message: "正文尚未保存，请重试。" });
					return;
				}
			}
			if (!(await applyMutation(mutation))) showAppToast({ intent: "danger", message: "草稿状态未保存，请重试。" });
		},
		[applyMutation, projectId],
	);
	const setPromptUsageStatus = useCallback(
		(promptId: string, isUsed: boolean) => {
			void performPromptMutationAfterFlushingItsText(promptId, {
				kind: "set_prompt_usage_status",
				promptId,
				isUsed,
			});
		},
		[performPromptMutationAfterFlushingItsText],
	);
	const convertPromptToReusableCommand = useCallback(
		(promptId: string, scope: "repo" | "global") => {
			void performPromptMutationAfterFlushingItsText(promptId, {
				kind: "convert_prompt_to_reusable_command",
				promptId,
				scope,
			});
		},
		[performPromptMutationAfterFlushingItsText],
	);

	const orphanedPrompts = useMemo(
		() => resolveOrphanedPrompts(librarySnapshot, taskIdsOnBoard),
		[librarySnapshot, taskIdsOnBoard],
	);

	return {
		prompts: visibleEntries.filter((entry) => entry.entryKind !== "reusable_command"),
		reusableCommands: visibleEntries.filter((entry) => entry.entryKind === "reusable_command"),
		orphanedPrompts,
		addPrompt,
		updatePromptText,
		removePrompt,
		setPromptScope,
		claimOrphanedPrompt,
		setPromptUsageStatus,
		convertPromptToReusableCommand,
	};
}
