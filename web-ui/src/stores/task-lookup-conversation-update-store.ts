let updateGeneration = 0;
const subscribers = new Set<() => void>();
const conversationRevisions = new Map<string, { revision: number; generation: number }>();
let unscopedUpdateGeneration = 0;
export function observeTaskLookupConversationUpdated(conversationId?: string, revision?: number): void {
	if (conversationId && revision !== undefined) {
		if ((conversationRevisions.get(conversationId)?.revision ?? -1) >= revision) return;
		conversationRevisions.set(conversationId, { revision, generation: updateGeneration + 1 });
	} else unscopedUpdateGeneration++;
	updateGeneration++;
	for (const subscriber of subscribers) subscriber();
}
export function subscribeToTaskLookupConversationUpdates(subscriber: () => void): () => void {
	subscribers.add(subscriber);
	return () => {
		subscribers.delete(subscriber);
	};
}
export const readTaskLookupConversationUpdateGeneration = (conversationId?: string | null) =>
	conversationId === undefined
		? updateGeneration
		: (conversationRevisions.get(conversationId ?? "")?.generation ?? 0) + unscopedUpdateGeneration;
