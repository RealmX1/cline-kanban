import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useExpandedForegroundViewNavigation } from "@/expanded-foreground-view/expanded-foreground-view-context";
import {
	type ExpandedForegroundViewTarget,
	expandedForegroundViewContentIdentity,
} from "@/expanded-foreground-view/expanded-foreground-view-navigation";

export function useExpandedForegroundViewSurface(target: ExpandedForegroundViewTarget | null, detached = false) {
	const navigation = useExpandedForegroundViewNavigation();
	const surfaceId = useId();
	const elementRef = useRef<HTMLDivElement>(null);
	const [localExpanded, setLocalExpanded] = useState(false);
	const registerSurface = navigation?.registerSurface;
	const releaseSurface = navigation?.releaseSurface;
	const contentIdentity = target ? expandedForegroundViewContentIdentity(target) : null;
	useEffect(() => {
		if (detached || !contentIdentity) return;
		registerSurface?.(surfaceId, contentIdentity);
		return () => releaseSurface?.(surfaceId);
	}, [registerSurface, releaseSurface, surfaceId, contentIdentity, detached]);
	const isExpanded =
		navigation && target
			? navigation.target !== null &&
				expandedForegroundViewContentIdentity(navigation.target) ===
					expandedForegroundViewContentIdentity(target) &&
				(detached ? navigation.ownerSurfaceId === null : navigation.ownerSurfaceId === surfaceId)
			: localExpanded;
	const open = useCallback(() => {
		if (navigation && target) navigation.open(target, detached ? undefined : surfaceId);
		else setLocalExpanded(true);
	}, [navigation, target, surfaceId, detached]);
	const close = useCallback(() => {
		if (navigation && target) navigation.close();
		else setLocalExpanded(false);
	}, [navigation, target]);
	return { elementRef, isExpanded, open, close };
}

export type ExpandedForegroundViewSurfaceController = ReturnType<typeof useExpandedForegroundViewSurface>;
