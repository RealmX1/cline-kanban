import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";

export interface NonModalFloatingFormOwnershipSnapshot {
	workspaceId?: string | null;
	taskId?: string | null;
	taskIncarnationCreatedAtEpochMs?: number;
	conversationSessionId?: string | null;
	sourceIdentity?: string;
	displayLabel?: string;
}

export interface NonModalFloatingFormWindowSession {
	instanceId: symbol;
	revealSequence: number;
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
	initialCascadeOffsetPx: number;
}

interface NonModalFloatingFormWindowHost {
	openWindow: (request: NonModalFloatingFormOpenRequest) => symbol;
	hasOpenWindows: boolean;
	closeWindow: (instanceId: symbol) => void;
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
				initialCascadeOffsetPx: (windowsRef.current.length % 6) * 32,
			},
		];
		setWindows(windowsRef.current);
		setActiveInstanceId(instanceId);
		return instanceId;
	}, []);
	const hasOpenWindows = windows.length > 0;
	const host = useMemo(() => ({ openWindow, closeWindow, hasOpenWindows }), [openWindow, closeWindow, hasOpenWindows]);
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
}: {
	entry: HostedNonModalFloatingFormWindow;
	isActive: boolean;
	onActivate: (instanceId: symbol) => void;
	onClose: (instanceId: symbol) => void;
}) {
	const session = useMemo(
		() => ({
			instanceId: entry.instanceId,
			revealSequence: entry.revealSequence,
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
			entry.initialCascadeOffsetPx,
			entry.ownership,
			entry.revealDetail,
			isActive,
			onActivate,
			onClose,
		],
	);
	return (
		<NonModalFloatingFormWindowSessionContext.Provider value={session}>
			{entry.render(session)}
		</NonModalFloatingFormWindowSessionContext.Provider>
	);
}
