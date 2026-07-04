import { useCallback, useMemo } from "react";

import { LocalStorageKey } from "@/storage/local-storage-store";
import { useJsonLocalStorageValue } from "@/utils/react-use";

// ponytail: prompt library is persisted in localStorage only — per-browser / per-machine,
// lost on cache clear, not synced across machines, and orphan keys remain after a task card is
// deleted (harmless). Single-origin server makes the global key naturally cross-task + cross-repo.
// Upgrade path if server-side persistence/sync is ever needed: global → runtime-config.ts config.json;
// per-task → a new RuntimeBoardCard field written to board.json.

export type PromptScope = "global" | "repo" | "task";

export interface StoredPrompt {
	id: string;
	text: string;
	scope: PromptScope;
	createdAt: number;
	updatedAt: number;
}

/** Combined snapshot of both localStorage-backed stores; the unit of the pure reducers below. */
export interface PromptLibraryState {
	global: StoredPrompt[];
	byProject: Record<string, StoredPrompt[]>;
	byTask: Record<string, StoredPrompt[]>;
}

const EMPTY_GLOBAL_PROMPTS: StoredPrompt[] = [];
const EMPTY_BY_PROJECT_PROMPTS: Record<string, StoredPrompt[]> = {};
const EMPTY_BY_TASK_PROMPTS: Record<string, StoredPrompt[]> = {};

function normalizePromptScope(scope: PromptScope | string | undefined): PromptScope {
	if (scope === "global" || scope === "repo") {
		return scope;
	}
	return "task";
}

function normalizeStoredPrompt(prompt: StoredPrompt): StoredPrompt {
	const updatedAt = Number.isFinite(prompt.updatedAt) ? prompt.updatedAt : Date.now();
	const createdAt = Number.isFinite(prompt.createdAt) ? prompt.createdAt : updatedAt;
	return {
		...prompt,
		scope: normalizePromptScope(prompt.scope),
		createdAt,
		updatedAt,
	};
}

function normalizePromptList(prompts: StoredPrompt[] | undefined): StoredPrompt[] {
	return (prompts ?? []).map(normalizeStoredPrompt);
}

/** Visible prompts for a task = global group first, then repo prompts, then this task's own group. */
export function resolveVisiblePrompts(state: PromptLibraryState, taskId: string, projectId: string): StoredPrompt[] {
	return [
		...normalizePromptList(state.global),
		...normalizePromptList(state.byProject[projectId]),
		...normalizePromptList(state.byTask[taskId]),
	];
}

export function addTaskPrompt(state: PromptLibraryState, taskId: string, id: string, now: number): PromptLibraryState {
	const taskPrompts = state.byTask[taskId] ?? [];
	const created: StoredPrompt = { id, text: "", scope: "task", createdAt: now, updatedAt: now };
	return { ...state, byTask: { ...state.byTask, [taskId]: [...taskPrompts, created] } };
}

export function updatePromptTextInLibrary(
	state: PromptLibraryState,
	taskId: string,
	projectId: string,
	id: string,
	text: string,
	now: number,
): PromptLibraryState {
	if (state.global.some((prompt) => prompt.id === id)) {
		return {
			...state,
			global: state.global.map((prompt) =>
				prompt.id === id ? { ...normalizeStoredPrompt(prompt), text, updatedAt: now } : prompt,
			),
		};
	}
	const projectPrompts = state.byProject[projectId] ?? [];
	if (projectPrompts.some((prompt) => prompt.id === id)) {
		return {
			...state,
			byProject: {
				...state.byProject,
				[projectId]: projectPrompts.map((prompt) =>
					prompt.id === id ? { ...normalizeStoredPrompt(prompt), text, updatedAt: now } : prompt,
				),
			},
		};
	}
	const taskPrompts = state.byTask[taskId] ?? [];
	if (taskPrompts.some((prompt) => prompt.id === id)) {
		return {
			...state,
			byTask: {
				...state.byTask,
				[taskId]: taskPrompts.map((prompt) =>
					prompt.id === id ? { ...normalizeStoredPrompt(prompt), text, updatedAt: now } : prompt,
				),
			},
		};
	}
	return state;
}

export function removePromptFromLibrary(
	state: PromptLibraryState,
	taskId: string,
	projectId: string,
	id: string,
): PromptLibraryState {
	if (state.global.some((prompt) => prompt.id === id)) {
		return { ...state, global: state.global.filter((prompt) => prompt.id !== id) };
	}
	const projectPrompts = state.byProject[projectId] ?? [];
	if (projectPrompts.some((prompt) => prompt.id === id)) {
		return {
			...state,
			byProject: { ...state.byProject, [projectId]: projectPrompts.filter((prompt) => prompt.id !== id) },
		};
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
	projectId: string,
	id: string,
	scope: PromptScope,
	now: number,
): PromptLibraryState {
	const taskPrompts = state.byTask[taskId] ?? [];
	const projectPrompts = state.byProject[projectId] ?? [];
	const found =
		state.global.find((prompt) => prompt.id === id) ??
		projectPrompts.find((prompt) => prompt.id === id) ??
		taskPrompts.find((prompt) => prompt.id === id);
	if (!found || found.scope === scope) {
		return state;
	}
	const moved: StoredPrompt = { ...normalizeStoredPrompt(found), scope, updatedAt: now };
	const nextGlobal = state.global.filter((prompt) => prompt.id !== id);
	const nextProjectPrompts = projectPrompts.filter((prompt) => prompt.id !== id);
	const nextTaskPrompts = taskPrompts.filter((prompt) => prompt.id !== id);
	if (scope === "global") {
		return {
			global: [...nextGlobal, moved],
			byProject: { ...state.byProject, [projectId]: nextProjectPrompts },
			byTask: { ...state.byTask, [taskId]: nextTaskPrompts },
		};
	}
	if (scope === "repo") {
		return {
			global: nextGlobal,
			byProject: { ...state.byProject, [projectId]: [...nextProjectPrompts, moved] },
			byTask: { ...state.byTask, [taskId]: nextTaskPrompts },
		};
	}
	return {
		global: nextGlobal,
		byProject: { ...state.byProject, [projectId]: nextProjectPrompts },
		byTask: { ...state.byTask, [taskId]: [...nextTaskPrompts, moved] },
	};
}

export interface PromptLibraryController {
	prompts: StoredPrompt[];
	addPrompt: () => string;
	updatePromptText: (id: string, text: string) => void;
	removePrompt: (id: string) => void;
	setPromptScope: (id: string, scope: PromptScope) => void;
}

function createPromptId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function usePromptLibrary(taskId: string, projectId: string): PromptLibraryController {
	const [global, setGlobal] = useJsonLocalStorageValue<StoredPrompt[]>(
		LocalStorageKey.PromptLibraryGlobal,
		EMPTY_GLOBAL_PROMPTS,
	);
	const [byProject, setByProject] = useJsonLocalStorageValue<Record<string, StoredPrompt[]>>(
		LocalStorageKey.PromptLibraryByProject,
		EMPTY_BY_PROJECT_PROMPTS,
	);
	const [byTask, setByTask] = useJsonLocalStorageValue<Record<string, StoredPrompt[]>>(
		LocalStorageKey.PromptLibraryByTask,
		EMPTY_BY_TASK_PROMPTS,
	);

	const applyReducer = useCallback(
		(reduce: (state: PromptLibraryState) => PromptLibraryState) => {
			const current: PromptLibraryState = { global, byProject, byTask };
			const next = reduce(current);
			if (next.global !== current.global) {
				setGlobal(next.global);
			}
			if (next.byProject !== current.byProject) {
				setByProject(next.byProject);
			}
			if (next.byTask !== current.byTask) {
				setByTask(next.byTask);
			}
		},
		[global, byProject, byTask, setGlobal, setByProject, setByTask],
	);

	const prompts = useMemo(
		() => resolveVisiblePrompts({ global, byProject, byTask }, taskId, projectId),
		[global, byProject, byTask, taskId, projectId],
	);

	const addPrompt = useCallback(() => {
		const promptId = createPromptId();
		applyReducer((state) => addTaskPrompt(state, taskId, promptId, Date.now()));
		return promptId;
	}, [applyReducer, taskId]);

	const updatePromptText = useCallback(
		(id: string, text: string) => {
			applyReducer((state) => updatePromptTextInLibrary(state, taskId, projectId, id, text, Date.now()));
		},
		[applyReducer, taskId, projectId],
	);

	const removePrompt = useCallback(
		(id: string) => {
			applyReducer((state) => removePromptFromLibrary(state, taskId, projectId, id));
		},
		[applyReducer, taskId, projectId],
	);

	const setPromptScope = useCallback(
		(id: string, scope: PromptScope) => {
			applyReducer((state) => setPromptScopeInLibrary(state, taskId, projectId, id, scope, Date.now()));
		},
		[applyReducer, taskId, projectId],
	);

	return { prompts, addPrompt, updatePromptText, removePrompt, setPromptScope };
}
