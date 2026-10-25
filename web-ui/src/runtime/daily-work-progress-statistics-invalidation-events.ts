let snapshot = { generation: 0, quietGeneration: 0 };
const listeners = new Set<() => void>();
export function observeDailyWorkProgressStatisticsUpdated(quiet = false): void {
	snapshot = { generation: snapshot.generation + 1, quietGeneration: snapshot.quietGeneration + (quiet ? 1 : 0) };
	for (const listener of listeners) listener();
}
export function subscribeToDailyWorkProgressStatisticsUpdates(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
export function readDailyWorkProgressStatisticsUpdateSnapshot() {
	return snapshot;
}
