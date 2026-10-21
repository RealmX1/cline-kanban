let updateGeneration = 0;
const subscribers = new Set<() => void>();
export function observeTaskLookupConversationUpdated(): void {
	updateGeneration++;
	for (const subscriber of subscribers) subscriber();
}
export function subscribeToTaskLookupConversationUpdates(subscriber: () => void): () => void {
	subscribers.add(subscriber);
	return () => {
		subscribers.delete(subscriber);
	};
}
export const readTaskLookupConversationUpdateGeneration = () => updateGeneration;
