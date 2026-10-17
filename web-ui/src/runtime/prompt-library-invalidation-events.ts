const listeners = new Set<(workspaceId: string | null) => void>();

export function notifyPromptLibraryInvalidated(workspaceId: string | null): void {
	for (const listener of listeners) listener(workspaceId);
}

export function subscribeToPromptLibraryInvalidations(listener: (workspaceId: string | null) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
