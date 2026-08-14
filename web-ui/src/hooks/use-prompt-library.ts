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
// （既卡输入又把库文件锁成热点）。所以正文编辑先进本地 `locallyEditedTextByPromptId` 立即回显，静默
// 一段时间后才落盘；组件卸载时强制冲刷，避免「打完字直接切走」丢掉最后一段。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

export interface PromptLibraryController {
	prompts: StoredPrompt[];
	addPrompt: () => string;
	updatePromptText: (id: string, text: string) => void;
	removePrompt: (id: string) => void;
	setPromptScope: (id: string, scope: PromptScope) => void;
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

export function usePromptLibrary(taskId: string, projectId: string): PromptLibraryController {
	const [librarySnapshot, setLibrarySnapshot] = useState<WorkspacePromptLibrarySnapshot>(
		EMPTY_WORKSPACE_PROMPT_LIBRARY_SNAPSHOT,
	);
	// 正在编辑、尚未落盘的正文。它盖在服务端快照之上，于是打字是即时的，落盘是去抖的。
	const [locallyEditedTextByPromptId, setLocallyEditedTextByPromptId] = useState<Record<string, string>>({});

	// 去抖冲刷要读「此刻最新的待落盘正文」，而定时器回调拿到的是它注册那一刻的闭包，所以走 ref。
	const locallyEditedTextByPromptIdRef = useRef(locallyEditedTextByPromptId);
	locallyEditedTextByPromptIdRef.current = locallyEditedTextByPromptId;
	const persistDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// workspace 切换后旧请求的响应可能才回来，直接 setState 会把新库覆盖成旧库。用它标记「当前是谁」。
	const activeProjectIdRef = useRef(projectId);
	activeProjectIdRef.current = projectId;

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
			const requestedProjectId = projectId;
			const nextSnapshot = await mutateWorkspacePromptLibrary(requestedProjectId, mutation).catch(() => null);
			if (nextSnapshot === null) {
				return false;
			}
			// 切了 workspace 之后旧请求才回来时不去覆盖界面：拿旧库覆盖新库会让用户看到上一个项目的模板。
			// 但这一趟**写入本身是成功的**，所以照样报 true——报 false 会让冲刷以为没落盘，把一份已经落进
			// 上一个 workspace 的正文永远挂在本地。
			if (activeProjectIdRef.current !== requestedProjectId) {
				return true;
			}
			setLibrarySnapshot(nextSnapshot);
			return true;
		},
		[projectId],
	);

	const flushPendingPromptTextEdits = useCallback((): void => {
		const pendingEdits = locallyEditedTextByPromptIdRef.current;
		const pendingPromptIds = Object.keys(pendingEdits);
		if (pendingPromptIds.length === 0) {
			return;
		}
		for (const promptId of pendingPromptIds) {
			const text = pendingEdits[promptId];
			if (text === undefined) {
				continue;
			}
			// 这里的 `scope`/`taskId` 只在「服务端找不到这个 id、要新建」时才生效——upsert_prompt 对
			// **已存在**的条目只改正文、绝不动它所在的桶（见 prompt-library-store 的意图语义）。所以给
			// 全局/仓库作用域的条目改文也不会把它拽进当前任务。仅有的落差是：某条目在两次击键之间被
			// 别处删掉时，这次冲刷会把它按 task scope 重建出来。可接受——重建回来的是用户刚打的字，
			// 而反过来（丢掉）才是真损失。
			void applyMutation({ kind: "upsert_prompt", promptId, text, scope: "task", taskId }).then(
				(didServerPersistThisText) => {
					// 没落盘就**不能**清：清掉等于界面立刻回落成服务端旧正文，用户刚打的字凭空消失且无处
					// 找回。留着它则界面继续显示用户打的那份，下一次击键的去抖冲刷或卸载冲刷会再送一遍。
					// 刻意不在这里自己起重试定时器：服务端持续写失败时那会退化成 600ms 一发的请求风暴，而
					// 这条路径上没有任何错误提示能让用户知道后台正在反复重试。
					if (!didServerPersistThisText) {
						return;
					}
					// 只清掉「落盘的正是当前这份」的条目：请求在途时用户又打了字的话，那份新正文必须留下来
					// 等下一轮冲刷，否则最后几个字符会被静默丢掉。
					setLocallyEditedTextByPromptId((current) => {
						if (current[promptId] !== text) {
							return current;
						}
						const { [promptId]: _flushed, ...remaining } = current;
						return remaining;
					});
				},
			);
		}
	}, [applyMutation, taskId]);

	// 载入服务端库，并把这台浏览器里的历史条目合并上去。
	useEffect(() => {
		let isCurrent = true;
		void (async () => {
			const snapshot = await fetchWorkspacePromptLibrary(projectId).catch(() => null);
			if (!isCurrent) {
				return;
			}
			// 读不出来（库文件损坏等）时保持空列表，且**不做迁移**——把损坏当空库会再叠一份重复数据。
			if (snapshot === null) {
				return;
			}
			setLibrarySnapshot(snapshot);
			if (hasUploadedPromptLibraryToServer(projectId)) {
				return;
			}
			const promptsToMigrate = readPromptLibraryMigrationPayloadFromBrowserLocalStorage(projectId);
			if (promptsToMigrate.length === 0) {
				return;
			}
			const mergedSnapshot = await mutateWorkspacePromptLibrary(projectId, {
				kind: "merge_prompts_migrated_from_browser_local_storage",
				prompts: promptsToMigrate,
			}).catch(() => null);
			if (!isCurrent || mergedSnapshot === null) {
				// 迁移失败就不打标记，下次挂载再试。合并是幂等的，重试不会造出重复条目。
				return;
			}
			setLibrarySnapshot(mergedSnapshot);
			writeLocalStorageItem(
				PROMPT_LIBRARY_MIGRATION_MARKER_STORAGE_KEY,
				JSON.stringify(buildPromptLibraryMigrationMarkersWithWorkspaceMarked(projectId, Date.now())),
			);
		})();
		return () => {
			isCurrent = false;
		};
	}, [projectId]);

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

	const prompts = useMemo(() => {
		const visiblePrompts = resolveVisiblePrompts(librarySnapshot, taskId);
		if (Object.keys(locallyEditedTextByPromptId).length === 0) {
			return visiblePrompts;
		}
		return visiblePrompts.map((prompt) => {
			const locallyEditedText = locallyEditedTextByPromptId[prompt.id];
			return locallyEditedText === undefined ? prompt : { ...prompt, text: locallyEditedText };
		});
	}, [librarySnapshot, locallyEditedTextByPromptId, taskId]);

	const addPrompt = useCallback((): string => {
		const promptId = createPromptId();
		setLibrarySnapshot((current) => withOptimisticallyCreatedPrompt(current, promptId, taskId, Date.now()));
		void applyMutation({ kind: "upsert_prompt", promptId, text: "", scope: "task", taskId, origin: "manual" });
		return promptId;
	}, [applyMutation, taskId]);

	const updatePromptText = useCallback(
		(promptId: string, text: string) => {
			setLocallyEditedTextByPromptId((current) => ({ ...current, [promptId]: text }));
			if (persistDebounceTimerRef.current !== null) {
				clearTimeout(persistDebounceTimerRef.current);
			}
			persistDebounceTimerRef.current = setTimeout(() => {
				persistDebounceTimerRef.current = null;
				flushPendingPromptTextEdits();
			}, PROMPT_TEXT_PERSIST_DEBOUNCE_MS);
		},
		[flushPendingPromptTextEdits],
	);

	const removePrompt = useCallback(
		(promptId: string) => {
			// 连本地那份待落盘正文一起丢掉：留着它会让这条被删的条目在下一次冲刷时又被 upsert 回来。
			setLocallyEditedTextByPromptId((current) => {
				const { [promptId]: _removed, ...remaining } = current;
				return remaining;
			});
			void applyMutation({ kind: "remove_prompt", promptId });
		},
		[applyMutation],
	);

	const setPromptScope = useCallback(
		(promptId: string, scope: PromptScope) => {
			void applyMutation({ kind: "set_prompt_scope", promptId, scope, taskId: scope === "task" ? taskId : null });
		},
		[applyMutation, taskId],
	);

	return { prompts, addPrompt, updatePromptText, removePrompt, setPromptScope };
}
