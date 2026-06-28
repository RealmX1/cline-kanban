import { useCallback, useMemo } from "react";

import { LocalStorageKey } from "@/storage/local-storage-store";
import { useJsonLocalStorageValue } from "@/utils/react-use";

// ponytail: prompt library is persisted in localStorage only — per-browser / per-machine,
// lost on cache clear, not synced across machines, and orphan keys remain after a task card is
// deleted (harmless). Single-origin server makes the global key naturally cross-task + cross-repo.
// Upgrade path if server-side persistence/sync is ever needed: global → runtime-config.ts config.json;
// per-task → a new RuntimeBoardCard field written to board.json.

export type PromptScope = "global" | "task";

export interface StoredPrompt {
	id: string;
	text: string;
	scope: PromptScope;
	updatedAt: number;
}

/** Combined snapshot of both localStorage-backed stores; the unit of the pure reducers below. */
export interface PromptLibraryState {
	global: StoredPrompt[];
	byTask: Record<string, StoredPrompt[]>;
}

const EMPTY_GLOBAL_PROMPTS: StoredPrompt[] = [];
const EMPTY_BY_TASK_PROMPTS: Record<string, StoredPrompt[]> = {};

/** Visible prompts for a task = global group first, then this task's own group. */
export function resolveVisiblePrompts(state: PromptLibraryState, taskId: string): StoredPrompt[] {
	return [...state.global, ...(state.byTask[taskId] ?? [])];
}

export function addTaskPrompt(state: PromptLibraryState, taskId: string, id: string, now: number): PromptLibraryState {
	const taskPrompts = state.byTask[taskId] ?? [];
	const created: StoredPrompt = { id, text: "", scope: "task", updatedAt: now };
	return { ...state, byTask: { ...state.byTask, [taskId]: [...taskPrompts, created] } };
}

export function updatePromptTextInLibrary(
	state: PromptLibraryState,
	taskId: string,
	id: string,
	text: string,
	now: number,
): PromptLibraryState {
	if (state.global.some((prompt) => prompt.id === id)) {
		return {
			...state,
			global: state.global.map((prompt) => (prompt.id === id ? { ...prompt, text, updatedAt: now } : prompt)),
		};
	}
	const taskPrompts = state.byTask[taskId] ?? [];
	if (taskPrompts.some((prompt) => prompt.id === id)) {
		return {
			...state,
			byTask: {
				...state.byTask,
				[taskId]: taskPrompts.map((prompt) => (prompt.id === id ? { ...prompt, text, updatedAt: now } : prompt)),
			},
		};
	}
	return state;
}

export function removePromptFromLibrary(state: PromptLibraryState, taskId: string, id: string): PromptLibraryState {
	if (state.global.some((prompt) => prompt.id === id)) {
		return { ...state, global: state.global.filter((prompt) => prompt.id !== id) };
	}
	const taskPrompts = state.byTask[taskId] ?? [];
	if (taskPrompts.some((prompt) => prompt.id === id)) {
		return {
			...state,
			byTask: { ...state.byTask, [taskId]: taskPrompts.filter((prompt) => prompt.id !== id) },
		};
	}
	return state;
}

/** Moving scope physically relocates the prompt between the global store and this task's store. */
export function setPromptScopeInLibrary(
	state: PromptLibraryState,
	taskId: string,
	id: string,
	scope: PromptScope,
	now: number,
): PromptLibraryState {
	const taskPrompts = state.byTask[taskId] ?? [];
	const found = state.global.find((prompt) => prompt.id === id) ?? taskPrompts.find((prompt) => prompt.id === id);
	if (!found || found.scope === scope) {
		return state;
	}
	const moved: StoredPrompt = { ...found, scope, updatedAt: now };
	if (scope === "global") {
		return {
			global: [...state.global, moved],
			byTask: { ...state.byTask, [taskId]: taskPrompts.filter((prompt) => prompt.id !== id) },
		};
	}
	return {
		global: state.global.filter((prompt) => prompt.id !== id),
		byTask: { ...state.byTask, [taskId]: [...taskPrompts, moved] },
	};
}

export interface PromptLibraryController {
	prompts: StoredPrompt[];
	addPrompt: () => void;
	updatePromptText: (id: string, text: string) => void;
	removePrompt: (id: string) => void;
	setPromptScope: (id: string, scope: PromptScope) => void;
}

export function usePromptLibrary(taskId: string): PromptLibraryController {
	const [global, setGlobal] = useJsonLocalStorageValue<StoredPrompt[]>(
		LocalStorageKey.PromptLibraryGlobal,
		EMPTY_GLOBAL_PROMPTS,
	);
	const [byTask, setByTask] = useJsonLocalStorageValue<Record<string, StoredPrompt[]>>(
		LocalStorageKey.PromptLibraryByTask,
		EMPTY_BY_TASK_PROMPTS,
	);

	const applyReducer = useCallback(
		(reduce: (state: PromptLibraryState) => PromptLibraryState) => {
			const current: PromptLibraryState = { global, byTask };
			const next = reduce(current);
			if (next.global !== current.global) {
				setGlobal(next.global);
			}
			if (next.byTask !== current.byTask) {
				setByTask(next.byTask);
			}
		},
		[global, byTask, setGlobal, setByTask],
	);

	const prompts = useMemo(() => resolveVisiblePrompts({ global, byTask }, taskId), [global, byTask, taskId]);

	const addPrompt = useCallback(() => {
		applyReducer((state) => addTaskPrompt(state, taskId, crypto.randomUUID(), Date.now()));
	}, [applyReducer, taskId]);

	const updatePromptText = useCallback(
		(id: string, text: string) => {
			applyReducer((state) => updatePromptTextInLibrary(state, taskId, id, text, Date.now()));
		},
		[applyReducer, taskId],
	);

	const removePrompt = useCallback(
		(id: string) => {
			applyReducer((state) => removePromptFromLibrary(state, taskId, id));
		},
		[applyReducer, taskId],
	);

	const setPromptScope = useCallback(
		(id: string, scope: PromptScope) => {
			applyReducer((state) => setPromptScopeInLibrary(state, taskId, id, scope, Date.now()));
		},
		[applyReducer, taskId],
	);

	return { prompts, addPrompt, updatePromptText, removePrompt, setPromptScope };
}
