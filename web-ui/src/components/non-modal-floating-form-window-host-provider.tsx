import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";

export interface NonModalFloatingFormOwnershipSnapshot {
	workspaceId?: string | null;
	taskId?: string | null;
	taskIncarnationCreatedAtEpochMs?: number;
	/** 同一世任务迁移过的项目。只用于收起/复用匹配，不写入窗口身份。 */
	workspaceIdsUsedByTaskIncarnation?: readonly string[];
	conversationSessionId?: string | null;
	sourceIdentity?: string;
	displayLabel?: string;
	taskTitleSnapshot?: string;
}

function taskEditorWindowMatchesVisitedIdentity(
	ownership: NonModalFloatingFormOwnershipSnapshot,
	identity: NonModalFloatingFormOwnershipSnapshot,
) {
	if (!identity.taskId || ownership.taskId !== identity.taskId) return false;
	if (ownership.taskIncarnationCreatedAtEpochMs !== identity.taskIncarnationCreatedAtEpochMs) return false;
	if (!ownership.workspaceId) return false;
	return (
		ownership.workspaceId === identity.workspaceId ||
		identity.workspaceIdsUsedByTaskIncarnation?.includes(ownership.workspaceId) === true
	);
}

export interface NonModalFloatingFormWindowSession {
	instanceId: symbol;
	revealSequence: number;
	collapseSequence: number;
	reportRevealed: () => void;
	initialCascadeOffsetPx: number;
	ownership: NonModalFloatingFormOwnershipSnapshot;
	close: () => void;
	activate: () => void;
	isActive: boolean;
	revealDetail?: unknown;
}

interface NonModalFloatingFormOpenRequest {
	formKind: string;
	focusReturnElementCapturedAtOpeningRequest?: HTMLElement | null;
	instanceIdentity: string;
	ownership: NonModalFloatingFormOwnershipSnapshot;
	render: (session: NonModalFloatingFormWindowSession) => ReactNode;
	revealDetail?: unknown;
	onClosed?: () => void;
}

interface HostedNonModalFloatingFormWindow extends NonModalFloatingFormOpenRequest {
	instanceId: symbol;
	focusReturnElementCapturedAtOpeningRequest: HTMLElement | null;
	focusReturnFallbackAncestorCapturedAtOpeningRequest: HTMLElement | null;
	revealSequence: number;
	collapseSequence: number;
	initialCascadeOffsetPx: number;
}

export interface NonModalFloatingFormWindowHost {
	openWindow: (request: NonModalFloatingFormOpenRequest) => symbol;
	hasOpenWindows: boolean;
	closeWindow: (instanceId: symbol) => void;
	collapseTaskEditorWindowsExcept: (identity?: NonModalFloatingFormOwnershipSnapshot) => void;
	/** 迁移前已打开的编辑窗按原实例展开；当前项目身份的窗口仍走普通打开。 */
	revealTaskEditorPreservingEarlierWorkspace: (identity: NonModalFloatingFormOwnershipSnapshot) => boolean;
	subscribeToRevealedTaskEditors: (listener: (ownership: NonModalFloatingFormOwnershipSnapshot) => void) => () => void;
}

const NonModalFloatingFormWindowHostContext = createContext<NonModalFloatingFormWindowHost | null>(null);
const NonModalFloatingFormWindowSessionContext = createContext<NonModalFloatingFormWindowSession | null>(null);

export function useNonModalFloatingFormWindowHost() {
	return useContext(NonModalFloatingFormWindowHostContext);
}

export function useNonModalFloatingFormWindowSession() {
	return useContext(NonModalFloatingFormWindowSessionContext);
}

/** 实例由页面宿主持有；入口卸载、背景导航和重复打开均不销毁已填写的表单。 */
export function NonModalFloatingFormWindowHostProvider({ children }: { children: ReactNode }) {
	const nextWindowSequence = useRef(0);
	const windowsRef = useRef<HostedNonModalFloatingFormWindow[]>([]);
	const [windows, setWindows] = useState<HostedNonModalFloatingFormWindow[]>([]);
	const [activeInstanceId, setActiveInstanceId] = useState<symbol | null>(null);
	const taskEditorRevealListeners = useRef(new Set<(ownership: NonModalFloatingFormOwnershipSnapshot) => void>());
	const subscribeToRevealedTaskEditors = useCallback(
		(listener: (ownership: NonModalFloatingFormOwnershipSnapshot) => void) => {
			taskEditorRevealListeners.current.add(listener);
			return () => {
				taskEditorRevealListeners.current.delete(listener);
			};
		},
		[],
	);
	const reportWindowRevealed = useCallback((instanceId: symbol) => {
		const entry = windowsRef.current.find((candidate) => candidate.instanceId === instanceId);
		if (entry?.formKind === "task-editor" && entry.ownership.taskId)
			for (const listener of taskEditorRevealListeners.current) listener(entry.ownership);
	}, []);
	const collapseTaskEditorWindowsExcept = useCallback((identity?: NonModalFloatingFormOwnershipSnapshot) => {
		windowsRef.current = windowsRef.current.map((entry) => {
			if (entry.formKind !== "task-editor" || !entry.ownership.taskId) return entry;
			if (identity && taskEditorWindowMatchesVisitedIdentity(entry.ownership, identity)) return entry;
			return { ...entry, collapseSequence: entry.collapseSequence + 1 };
		});
		setWindows(windowsRef.current);
	}, []);
	const revealTaskEditorPreservingEarlierWorkspace = useCallback((identity: NonModalFloatingFormOwnershipSnapshot) => {
		const match = windowsRef.current.find(
			(entry) =>
				entry.formKind === "task-editor" &&
				entry.ownership.workspaceId !== identity.workspaceId &&
				taskEditorWindowMatchesVisitedIdentity(entry.ownership, identity),
		);
		if (!match) return false;
		windowsRef.current = windowsRef.current.map((entry) => {
			if (entry.formKind !== "task-editor" || !entry.ownership.taskId) return entry;
			if (entry.instanceId === match.instanceId) return { ...entry, revealSequence: entry.revealSequence + 1 };
			return { ...entry, collapseSequence: entry.collapseSequence + 1 };
		});
		setWindows(windowsRef.current);
		setActiveInstanceId(match.instanceId);
		return true;
	}, []);
	const closeWindow = useCallback((instanceId: symbol) => {
		const closing = windowsRef.current.find((entry) => entry.instanceId === instanceId);
		if (!closing) return;
		const focusedFloatingForm = document.activeElement?.closest("[data-non-modal-floating-form-window]");
		const shouldReturnFocus =
			document.activeElement === document.body ||
			focusedFloatingForm?.getAttribute("data-floating-form-instance-id") === String(instanceId);
		windowsRef.current = windowsRef.current.filter((entry) => entry.instanceId !== instanceId);
		setWindows(windowsRef.current);
		setActiveInstanceId((active) =>
			active === instanceId ? (windowsRef.current.at(-1)?.instanceId ?? null) : active,
		);
		const focusReturnTarget = closing.focusReturnElementCapturedAtOpeningRequest?.isConnected
			? closing.focusReturnElementCapturedAtOpeningRequest
			: closing.focusReturnFallbackAncestorCapturedAtOpeningRequest;
		if (shouldReturnFocus && focusReturnTarget?.isConnected) focusReturnTarget.focus({ preventScroll: true });
		closing.onClosed?.();
	}, []);
	const openWindow = useCallback((request: NonModalFloatingFormOpenRequest) => {
		const focusReturnElement =
			request.focusReturnElementCapturedAtOpeningRequest ??
			(document.activeElement instanceof HTMLElement ? document.activeElement : null);
		const existing = windowsRef.current.find(
			(entry) => entry.formKind === request.formKind && entry.instanceIdentity === request.instanceIdentity,
		);
		if (existing) {
			windowsRef.current = windowsRef.current.map((entry) =>
				entry === existing
					? {
							...entry,
							revealSequence: entry.revealSequence + 1,
							onClosed: request.onClosed,
							revealDetail: request.revealDetail,
						}
					: entry,
			);
			setWindows(windowsRef.current);
			setActiveInstanceId(existing.instanceId);
			return existing.instanceId;
		}
		const instanceId = Symbol(String(++nextWindowSequence.current));
		windowsRef.current = [
			...windowsRef.current,
			{
				...request,
				instanceId,
				focusReturnElementCapturedAtOpeningRequest: focusReturnElement,
				focusReturnFallbackAncestorCapturedAtOpeningRequest:
					focusReturnElement?.parentElement?.closest<HTMLElement>('[tabindex], [role="dialog"]') ?? null,
				revealSequence: 0,
				collapseSequence: 0,
				initialCascadeOffsetPx: (windowsRef.current.length % 6) * 32,
			},
		];
		setWindows(windowsRef.current);
		setActiveInstanceId(instanceId);
		return instanceId;
	}, []);
	const hasOpenWindows = windows.length > 0;
	const host = useMemo(
		() => ({
			openWindow,
			closeWindow,
			hasOpenWindows,
			collapseTaskEditorWindowsExcept,
			revealTaskEditorPreservingEarlierWorkspace,
			subscribeToRevealedTaskEditors,
		}),
		[
			openWindow,
			closeWindow,
			hasOpenWindows,
			collapseTaskEditorWindowsExcept,
			revealTaskEditorPreservingEarlierWorkspace,
			subscribeToRevealedTaskEditors,
		],
	);
	return (
		<NonModalFloatingFormWindowHostContext.Provider value={host}>
			{children}
			{windows.map((entry) => (
				<HostedNonModalFloatingFormWindowInstance
					key={String(entry.instanceId)}
					entry={entry}
					isActive={entry.instanceId === activeInstanceId}
					onActivate={setActiveInstanceId}
					onClose={closeWindow}
					onRevealed={reportWindowRevealed}
				/>
			))}
		</NonModalFloatingFormWindowHostContext.Provider>
	);
}

function HostedNonModalFloatingFormWindowInstance({
	entry,
	isActive,
	onActivate,
	onClose,
	onRevealed,
}: {
	entry: HostedNonModalFloatingFormWindow;
	isActive: boolean;
	onActivate: (instanceId: symbol) => void;
	onClose: (instanceId: symbol) => void;
	onRevealed: (instanceId: symbol) => void;
}) {
	const session = useMemo(
		() => ({
			instanceId: entry.instanceId,
			revealSequence: entry.revealSequence,
			collapseSequence: entry.collapseSequence,
			reportRevealed: () => onRevealed(entry.instanceId),
			initialCascadeOffsetPx: entry.initialCascadeOffsetPx,
			ownership: entry.ownership,
			isActive,
			revealDetail: entry.revealDetail,
			activate: () => onActivate(entry.instanceId),
			close: () => onClose(entry.instanceId),
		}),
		[
			entry.instanceId,
			entry.revealSequence,
			entry.collapseSequence,
			entry.initialCascadeOffsetPx,
			entry.ownership,
			entry.revealDetail,
			isActive,
			onActivate,
			onClose,
			onRevealed,
		],
	);
	return (
		<NonModalFloatingFormWindowSessionContext.Provider value={session}>
			{entry.render(session)}
		</NonModalFloatingFormWindowSessionContext.Provider>
	);
}
