import type { MutableRefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getTerminalThemeColors, useTheme } from "@/hooks/use-theme";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import {
	disposePersistentTerminal,
	ensurePersistentTerminal,
	type TerminalSearchResultState,
} from "@/terminal/persistent-terminal-manager";
import { registerTerminalController } from "@/terminal/terminal-controller-registry";

interface UsePersistentTerminalSessionInput {
	taskId: string;
	workspaceId: string | null;
	enabled?: boolean;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onConnectionReady?: (taskId: string) => void;
	autoFocus?: boolean;
	isVisible?: boolean;
	sessionStartedAt?: number | null;
	terminalBackgroundColor: string;
	cursorColor: string;
}

export interface UsePersistentTerminalSessionResult {
	containerRef: MutableRefObject<HTMLDivElement | null>;
	lastError: string | null;
	isStopping: boolean;
	isRefreshing: boolean;
	isSearchOpen: boolean;
	searchOpenRequestKey: number;
	searchResults: TerminalSearchResultState;
	clearTerminal: () => void;
	closeTerminalSearch: () => void;
	findNextInTerminal: (query: string, options?: { caseSensitive?: boolean }) => boolean;
	findPreviousInTerminal: (query: string, options?: { caseSensitive?: boolean }) => boolean;
	openTerminalSearch: () => void;
	refreshTerminal: () => Promise<void>;
	stopTerminal: () => Promise<void>;
}

function getEmptyTerminalSearchResults(): TerminalSearchResultState {
	return { resultCount: 0, resultIndex: -1 };
}

export function usePersistentTerminalSession({
	taskId,
	workspaceId,
	enabled = true,
	onSummary,
	onConnectionReady,
	autoFocus = false,
	isVisible = true,
	sessionStartedAt = null,
	terminalBackgroundColor,
	cursorColor,
}: UsePersistentTerminalSessionInput): UsePersistentTerminalSessionResult {
	const { themeId } = useTheme();
	const themeColors = useMemo(() => getTerminalThemeColors(themeId), [themeId]);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const terminalRef = useRef<ReturnType<typeof ensurePersistentTerminal> | null>(null);
	const recentlyUnmountedTerminalRef = useRef<ReturnType<typeof ensurePersistentTerminal> | null>(null);
	const callbackRef = useRef<{
		onSummary?: (summary: RuntimeTaskSessionSummary) => void;
		onConnectionReady?: (taskId: string) => void;
	}>({
		onSummary,
		onConnectionReady,
	});
	const previousSessionRef = useRef<{
		workspaceId: string;
		taskId: string;
		sessionStartedAt: number | null;
	} | null>(null);
	const [lastError, setLastError] = useState<string | null>(null);
	const [isStopping, setIsStopping] = useState(false);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [isSearchOpen, setIsSearchOpen] = useState(false);
	const [searchOpenRequestKey, setSearchOpenRequestKey] = useState(0);
	const [searchResults, setSearchResults] = useState<TerminalSearchResultState>(getEmptyTerminalSearchResults);
	callbackRef.current = {
		onSummary,
		onConnectionReady,
	};

	const resetTerminalSearchState = useCallback(() => {
		setIsSearchOpen(false);
		setSearchOpenRequestKey(0);
		setSearchResults(getEmptyTerminalSearchResults());
	}, []);

	const getSearchCleanupTerminal = useCallback(() => {
		return terminalRef.current ?? recentlyUnmountedTerminalRef.current;
	}, []);

	useEffect(() => {
		if (!enabled) {
			const previousSession = previousSessionRef.current;
			if (previousSession) {
				disposePersistentTerminal(previousSession.workspaceId, previousSession.taskId);
			}
			getSearchCleanupTerminal()?.clearSearch();
			terminalRef.current?.unmount(containerRef.current);
			terminalRef.current = null;
			recentlyUnmountedTerminalRef.current = null;
			previousSessionRef.current = null;
			setLastError(null);
			setIsStopping(false);
			resetTerminalSearchState();
			return;
		}

		if (!workspaceId) {
			const previousSession = previousSessionRef.current;
			if (previousSession) {
				disposePersistentTerminal(previousSession.workspaceId, previousSession.taskId);
			}
			getSearchCleanupTerminal()?.clearSearch();
			terminalRef.current?.unmount(containerRef.current);
			terminalRef.current = null;
			recentlyUnmountedTerminalRef.current = null;
			previousSessionRef.current = null;
			setLastError("No project selected.");
			resetTerminalSearchState();
			return;
		}
		const previousSession = previousSessionRef.current;
		const didSessionIdentityChange =
			previousSession !== null &&
			(previousSession.workspaceId !== workspaceId ||
				previousSession.taskId !== taskId ||
				previousSession.sessionStartedAt !== sessionStartedAt);
		const didSessionRestart =
			previousSession !== null &&
			previousSession.workspaceId === workspaceId &&
			previousSession.taskId === taskId &&
			previousSession.sessionStartedAt !== sessionStartedAt;
		if (didSessionIdentityChange) {
			getSearchCleanupTerminal()?.clearSearch();
			resetTerminalSearchState();
		}

		const container = containerRef.current;
		if (!container) {
			return;
		}

		const terminal = ensurePersistentTerminal({
			taskId,
			workspaceId,
			cursorColor,
			terminalBackgroundColor,
			themeColors,
		});
		if (didSessionRestart) {
			// User-initiated refresh sets a suppression flag so the existing scrollback
			// (including the "[kanban] Refreshing terminal session..." banner) survives
			// the PTY swap. Normal restarts (e.g., trash-resume drag) still reset.
			if (!terminal.consumeRestartResetSuppression()) {
				terminal.reset();
			}
		}
		previousSessionRef.current = {
			workspaceId,
			taskId,
			sessionStartedAt,
		};
		terminalRef.current = terminal;
		recentlyUnmountedTerminalRef.current = null;
		const unsubscribe = terminal.subscribe({
			onConnectionReady: (connectedTaskId) => {
				callbackRef.current.onConnectionReady?.(connectedTaskId);
			},
			onLastError: setLastError,
			onSummary: (summary) => {
				callbackRef.current.onSummary?.(summary);
			},
			onSearchOpenRequested: () => {
				setIsSearchOpen(true);
				setSearchOpenRequestKey((current) => current + 1);
			},
			onSearchResults: setSearchResults,
		});
		terminal.mount(
			container,
			{
				cursorColor,
				terminalBackgroundColor,
				themeColors,
			},
			{
				autoFocus,
				isVisible,
			},
		);
		setLastError(null);
		setIsStopping(false);
		return () => {
			unsubscribe();
			terminal.unmount(container);
			if (terminalRef.current === terminal) {
				terminalRef.current = null;
				recentlyUnmountedTerminalRef.current = terminal;
			}
		};
	}, [
		autoFocus,
		cursorColor,
		enabled,
		isVisible,
		sessionStartedAt,
		taskId,
		terminalBackgroundColor,
		themeColors,
		getSearchCleanupTerminal,
		resetTerminalSearchState,
		workspaceId,
	]);

	useEffect(() => {
		return registerTerminalController(taskId, {
			input: (text) => terminalRef.current?.input(text) ?? false,
			paste: (text) => terminalRef.current?.paste(text) ?? false,
			waitForLikelyPrompt: async (timeoutMs) => await (terminalRef.current?.waitForLikelyPrompt(timeoutMs) ?? false),
		});
	}, [taskId]);

	const stopTerminal = useCallback(async () => {
		const terminal = terminalRef.current;
		if (!terminal) {
			return;
		}
		setIsStopping(true);
		try {
			await terminal.stop();
		} catch {
			// Keep terminal usable even if stop API fails.
		} finally {
			setIsStopping(false);
		}
	}, []);

	const refreshTerminal = useCallback(async () => {
		const terminal = terminalRef.current;
		if (!terminal) {
			return;
		}
		setIsRefreshing(true);
		try {
			const result = await terminal.refresh();
			if (!result.ok && result.error) {
				setLastError(result.error);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setLastError(message);
		} finally {
			setIsRefreshing(false);
		}
	}, []);

	const clearTerminal = useCallback(() => {
		terminalRef.current?.clear();
	}, []);

	const openTerminalSearch = useCallback(() => {
		setIsSearchOpen(true);
		setSearchOpenRequestKey((current) => current + 1);
	}, []);

	const closeTerminalSearch = useCallback(() => {
		const terminal = terminalRef.current;
		terminal?.clearSearch();
		terminal?.focus();
		setSearchResults(getEmptyTerminalSearchResults());
		setIsSearchOpen(false);
	}, []);

	const findNextInTerminal = useCallback((query: string, options?: { caseSensitive?: boolean }) => {
		return terminalRef.current?.searchNext(query, options) ?? false;
	}, []);

	const findPreviousInTerminal = useCallback((query: string, options?: { caseSensitive?: boolean }) => {
		return terminalRef.current?.searchPrevious(query, options) ?? false;
	}, []);

	return {
		containerRef,
		lastError,
		isStopping,
		isRefreshing,
		isSearchOpen,
		searchOpenRequestKey,
		searchResults,
		clearTerminal,
		closeTerminalSearch,
		findNextInTerminal,
		findPreviousInTerminal,
		openTerminalSearch,
		refreshTerminal,
		stopTerminal,
	};
}
