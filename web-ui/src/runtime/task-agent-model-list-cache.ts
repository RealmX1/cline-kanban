// Stale-while-revalidate cache for the task-creation-panel agent/model lists.
// The picker seeds from here instantly on open (so lists never flash empty), then
// revalidates in the background on every panel activation and overwrites on success.
// Keys are namespaced by scope: `terminal:${agentId}` (CLI models are machine-global),
// `cline-catalog:${workspaceId}`, `cline-models:${workspaceId}:${providerId}`.
const TASK_AGENT_MODEL_LIST_CACHE_KEY_PREFIX = "kanban:task-agent-model-cache:";

export function readTaskAgentModelListCache<T>(key: string): T | null {
	try {
		const raw = window.localStorage.getItem(TASK_AGENT_MODEL_LIST_CACHE_KEY_PREFIX + key);
		if (raw === null) {
			return null;
		}
		return JSON.parse(raw) as T;
	} catch {
		// Bad JSON, disabled storage, or SSR (no window) → treat as cache miss.
		return null;
	}
}

export function writeTaskAgentModelListCache<T>(key: string, value: T): void {
	try {
		window.localStorage.setItem(TASK_AGENT_MODEL_LIST_CACHE_KEY_PREFIX + key, JSON.stringify(value));
	} catch {
		// ponytail: localStorage full/disabled → skip caching; next open just re-fetches.
	}
}
