import { useSyncExternalStore } from "react";
import type { RuntimeSystemLoadAndRuntimeStatusSnapshot } from "@/runtime/types";

export type RuntimeSystemStatusStreamConnectionState = "connecting" | "connected" | "reconnecting";

let latestSystemLoadAndRuntimeStatusStoreSnapshot: {
	snapshot: RuntimeSystemLoadAndRuntimeStatusSnapshot | null;
	connectionState: RuntimeSystemStatusStreamConnectionState;
} = { snapshot: null, connectionState: "connecting" };
const systemStatusStoreListeners = new Set<() => void>();
const subscribeToSystemLoadAndRuntimeStatusStore = (listener: () => void) => {
	systemStatusStoreListeners.add(listener);
	return () => {
		systemStatusStoreListeners.delete(listener);
	};
};
const readSystemLoadAndRuntimeStatusStoreSnapshot = () => latestSystemLoadAndRuntimeStatusStoreSnapshot;

export function observeRuntimeSystemLoadAndRuntimeStatusSnapshot(
	snapshot: RuntimeSystemLoadAndRuntimeStatusSnapshot,
): void {
	latestSystemLoadAndRuntimeStatusStoreSnapshot = { ...latestSystemLoadAndRuntimeStatusStoreSnapshot, snapshot };
	for (const listener of systemStatusStoreListeners) listener();
}

export function updateRuntimeSystemStatusStreamConnectionState(
	connectionState: RuntimeSystemStatusStreamConnectionState,
): void {
	if (latestSystemLoadAndRuntimeStatusStoreSnapshot.connectionState === connectionState) return;
	latestSystemLoadAndRuntimeStatusStoreSnapshot = {
		...latestSystemLoadAndRuntimeStatusStoreSnapshot,
		connectionState,
	};
	for (const listener of systemStatusStoreListeners) listener();
}

export function useRuntimeSystemLoadAndRuntimeStatus() {
	return useSyncExternalStore(
		subscribeToSystemLoadAndRuntimeStatusStore,
		readSystemLoadAndRuntimeStatusStoreSnapshot,
		readSystemLoadAndRuntimeStatusStoreSnapshot,
	);
}
