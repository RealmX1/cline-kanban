type OwnerSessionInterruptObserver = (workspaceId: string, conversationSessionId: string) => Promise<void>;
const observers = new Set<OwnerSessionInterruptObserver>();

export function observeOwnerSessionInterruptBeforeOwnedCommandExecutionTerminalInterrupt(
	observer: OwnerSessionInterruptObserver,
): () => void {
	observers.add(observer);
	return () => {
		observers.delete(observer);
	};
}

export async function applyOwnedCommandExecutionPoliciesBeforeOwnerSessionTerminalInterrupt(
	workspaceId: string,
	conversationSessionId: string,
): Promise<void> {
	for (const observer of observers) await observer(workspaceId, conversationSessionId);
}
