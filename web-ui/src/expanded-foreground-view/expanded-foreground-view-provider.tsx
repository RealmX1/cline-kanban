import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExpandedForegroundViewContext } from "@/expanded-foreground-view/expanded-foreground-view-context";
import { ExpandedForegroundViewDetachedContent } from "@/expanded-foreground-view/expanded-foreground-view-detached-content";
import {
	buildExpandedForegroundViewUrl,
	type ExpandedForegroundViewTarget,
	expandedForegroundViewContentIdentity,
	parseExpandedForegroundViewTarget,
	removeExpandedForegroundViewFromUrl,
} from "@/expanded-foreground-view/expanded-foreground-view-navigation";
import { buildProjectTaskDeepLinkUrl } from "@/hooks/app-utils";
import { createRandomUuidV4WithInsecureContextFallback } from "@/utils/create-random-uuid-v4-with-insecure-context-fallback";

interface ForegroundHistoryEntry {
	providerSessionId: string;
	sourceUrl: string;
	ownerSurfaceId: string | null;
	returnNavigationMode: "source_history_entry" | "target_task";
}

function readHistoryEntry(): ForegroundHistoryEntry | null {
	const entry: unknown = window.history.state?.kanbanExpandedForegroundView;
	if (
		!entry ||
		typeof entry !== "object" ||
		!("providerSessionId" in entry) ||
		!("sourceUrl" in entry) ||
		!("ownerSurfaceId" in entry) ||
		!("returnNavigationMode" in entry)
	)
		return null;
	if (
		typeof entry.providerSessionId !== "string" ||
		typeof entry.sourceUrl !== "string" ||
		(entry.ownerSurfaceId !== null && typeof entry.ownerSurfaceId !== "string") ||
		(entry.returnNavigationMode !== "source_history_entry" && entry.returnNavigationMode !== "target_task")
	)
		return null;
	return entry as ForegroundHistoryEntry;
}

export function ExpandedForegroundViewProvider({ children }: { children: ReactNode }) {
	const [providerSessionId] = useState(createRandomUuidV4WithInsecureContextFallback);
	const [route, setRoute] = useState(() => ({
		...parseExpandedForegroundViewTarget(window.location.href),
		ownerSurfaceId: null as string | null,
	}));
	const routeRef = useRef(route);
	const returnFocusRef = useRef<HTMLElement | null>(null);
	const registeredSurfaceContentIdentitiesRef = useRef(new Map<string, string>());
	routeRef.current = route;
	useEffect(() => {
		if (!route.target && !route.error && returnFocusRef.current?.isConnected)
			returnFocusRef.current.focus({ preventScroll: true });
	}, [route.target, route.error]);
	const readLocation = useCallback(() => {
		const entry = readHistoryEntry();
		const parsed = parseExpandedForegroundViewTarget(window.location.href);
		const ownerSurfaceId =
			parsed.target &&
			entry?.providerSessionId === providerSessionId &&
			entry.ownerSurfaceId &&
			registeredSurfaceContentIdentitiesRef.current.get(entry.ownerSurfaceId) ===
				expandedForegroundViewContentIdentity(parsed.target)
				? entry.ownerSurfaceId
				: null;
		if (entry && entry.ownerSurfaceId !== ownerSurfaceId)
			window.history.replaceState(
				{ ...window.history.state, kanbanExpandedForegroundView: { ...entry, ownerSurfaceId } },
				"",
				window.location.href,
			);
		setRoute({
			...parsed,
			ownerSurfaceId,
		});
	}, [providerSessionId]);
	useEffect(() => {
		window.addEventListener("popstate", readLocation);
		return () => window.removeEventListener("popstate", readLocation);
	}, [readLocation]);
	const open = useCallback(
		(target: ExpandedForegroundViewTarget, ownerSurfaceId?: string) => {
			const entry = readHistoryEntry();
			const previous = routeRef.current;
			const nextOwnerSurfaceId =
				ownerSurfaceId &&
				registeredSurfaceContentIdentitiesRef.current.get(ownerSurfaceId) ===
					expandedForegroundViewContentIdentity(target)
					? ownerSurfaceId
					: null;
			if (!previous.target && document.activeElement instanceof HTMLElement) {
				const active = document.activeElement;
				const sourceDialogId = active.closest('[role="dialog"]')?.id;
				returnFocusRef.current = sourceDialogId
					? ([...document.querySelectorAll<HTMLElement>("[aria-controls]")].find(
							(element) => element.getAttribute("aria-controls") === sourceDialogId,
						) ?? active)
					: active;
			}
			const nextEntry: ForegroundHistoryEntry = {
				providerSessionId,
				sourceUrl:
					entry?.providerSessionId === providerSessionId
						? entry.sourceUrl
						: removeExpandedForegroundViewFromUrl(window.location.href),
				ownerSurfaceId: nextOwnerSurfaceId,
				returnNavigationMode:
					!previous.target && !previous.error
						? "source_history_entry"
						: entry?.providerSessionId === providerSessionId
							? entry.returnNavigationMode
							: "target_task",
			};
			const url = buildExpandedForegroundViewUrl(window.location.href, target);
			const state = { ...window.history.state, kanbanExpandedForegroundView: nextEntry };
			if (previous.target || previous.error) window.history.replaceState(state, "", url);
			else window.history.pushState(state, "", url);
			setRoute({ target, error: null, ownerSurfaceId: nextOwnerSurfaceId });
		},
		[providerSessionId],
	);
	const close = useCallback(() => {
		const entry = readHistoryEntry();
		if (entry?.providerSessionId === providerSessionId && entry.returnNavigationMode === "source_history_entry") {
			window.history.back();
			return;
		}
		const target = routeRef.current.target;
		const url = target
			? buildProjectTaskDeepLinkUrl(target.workspaceId, target.taskId)
			: removeExpandedForegroundViewFromUrl(window.location.href);
		const state = { ...window.history.state };
		delete state.kanbanExpandedForegroundView;
		window.history.replaceState(state, "", url);
		window.dispatchEvent(new PopStateEvent("popstate"));
	}, [providerSessionId]);
	const registerSurface = useCallback((surfaceId: string, contentIdentity: string) => {
		registeredSurfaceContentIdentitiesRef.current.set(surfaceId, contentIdentity);
	}, []);
	const dismissForTaskNavigation = useCallback(() => {
		// 任务导航自己接管 URL；不能再异步 back，否则 popstate 会覆盖刚打开的目标任务。
		returnFocusRef.current = null;
		const state = { ...window.history.state };
		delete state.kanbanExpandedForegroundView;
		window.history.replaceState(state, "", removeExpandedForegroundViewFromUrl(window.location.href));
		const dismissedRoute = { target: null, error: null, ownerSurfaceId: null };
		routeRef.current = dismissedRoute;
		setRoute(dismissedRoute);
	}, []);
	const releaseSurface = useCallback((surfaceId: string) => {
		registeredSurfaceContentIdentitiesRef.current.delete(surfaceId);
		if (routeRef.current.ownerSurfaceId !== surfaceId) return;
		const entry = readHistoryEntry();
		if (entry?.ownerSurfaceId === surfaceId)
			window.history.replaceState(
				{ ...window.history.state, kanbanExpandedForegroundView: { ...entry, ownerSurfaceId: null } },
				"",
				window.location.href,
			);
		setRoute((current) => (current.ownerSurfaceId === surfaceId ? { ...current, ownerSurfaceId: null } : current));
	}, []);
	const navigation = useMemo(
		() => ({
			target: route.target,
			ownerSurfaceId: route.ownerSurfaceId,
			open,
			close,
			dismissForTaskNavigation,
			registerSurface,
			releaseSurface,
		}),
		[route.target, route.ownerSurfaceId, open, close, dismissForTaskNavigation, registerSurface, releaseSurface],
	);
	return (
		<ExpandedForegroundViewContext.Provider value={navigation}>
			{children}
			{route.error ? (
				<div className="kb-expanded-foreground-view p-4" role="alert">
					<p>{route.error}</p>
					<button type="button" className="mt-3 text-accent" onClick={close}>
						返回任务
					</button>
				</div>
			) : route.target && route.ownerSurfaceId === null ? (
				<ExpandedForegroundViewDetachedContent
					key={JSON.stringify([
						route.target.viewKind,
						route.target.workspaceId,
						route.target.taskId,
						route.target.taskIncarnationCreatedAtEpochMs,
					])}
					target={route.target}
				/>
			) : null}
		</ExpandedForegroundViewContext.Provider>
	);
}
