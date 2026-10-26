import { createContext, useContext } from "react";
import type { ExpandedForegroundViewTarget } from "@/expanded-foreground-view/expanded-foreground-view-navigation";

export interface ExpandedForegroundViewNavigationController {
	target: ExpandedForegroundViewTarget | null;
	ownerSurfaceId: string | null;
	open: (target: ExpandedForegroundViewTarget, ownerSurfaceId?: string) => void;
	close: () => void;
	dismissForTaskNavigation: () => void;
	registerSurface: (surfaceId: string, contentIdentity: string) => void;
	releaseSurface: (surfaceId: string) => void;
}

export const ExpandedForegroundViewContext = createContext<ExpandedForegroundViewNavigationController | null>(null);

export function useExpandedForegroundViewNavigation() {
	return useContext(ExpandedForegroundViewContext);
}
