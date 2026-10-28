type UserStopObserver = (workspaceId: string, conversationSessionId: string) => Promise<void>;
const observers = new Set<UserStopObserver>();

export function observeUserStopBeforeOwnedCommandExecutionTerminalInterrupt(observer: UserStopObserver): () => void {
	observers.add(observer);
	return () => {
		observers.delete(observer);
	};
}

export async function persistOwnedCommandExecutionRevocationsBeforeUserTerminalInterrupt(
	workspaceId: string,
	conversationSessionId: string,
): Promise<void> {
	for (const observer of observers) await observer(workspaceId, conversationSessionId);
}
