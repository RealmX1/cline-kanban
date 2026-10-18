import { createContext, type RefObject, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useIsMobile } from "@/hooks/use-is-mobile";
import {
	type MobileFocusViewIdleCollapseController,
	useMobileFocusViewIdleCollapseController,
} from "@/hooks/use-mobile-focus-view-idle-collapse-controller";

export interface MobileFocusViewCollapsibleControls {
	isEnabled: boolean;
	visibleViewportHeightPx: number | undefined;
	focusViewRootRef: RefObject<HTMLDivElement>;
	idleCollapseController: MobileFocusViewIdleCollapseController;
	upperNavigationAndToolsExpanded: boolean;
	lowerVirtualKeyBarExpanded: boolean;
	toggleUpperNavigationAndTools: () => void;
	expandLowerVirtualKeyBar: () => void;
	collapseLowerVirtualKeyBar: () => void;
}
const MobileFocusViewCollapsibleControlsContext = createContext<MobileFocusViewCollapsibleControls | null>(null);
export const MobileFocusViewCollapsibleControlsProvider = MobileFocusViewCollapsibleControlsContext.Provider;
export function useSharedMobileFocusViewCollapsibleControls(): MobileFocusViewCollapsibleControls | null {
	return useContext(MobileFocusViewCollapsibleControlsContext);
}

/** 唯一闲置时钟覆盖全局顶栏及详情；三个区域只共享收起通知，不共享手动展开状态。 */
export function useMobileFocusViewCollapsibleControls({
	enabled,
	focusedTaskIdentity,
	isDocumentVisible = true,
}: {
	enabled: boolean;
	focusedTaskIdentity: string;
	isDocumentVisible?: boolean;
}): MobileFocusViewCollapsibleControls {
	const isMobile = useIsMobile();
	const focusViewRootRef = useRef<HTMLDivElement>(null);
	const isEnabled = enabled && isMobile;
	const [visibleViewportHeightPx, setVisibleViewportHeightPx] = useState<number>();
	useEffect(() => {
		const viewport = window.visualViewport;
		if (!isEnabled || !viewport) return;
		const updateVisibleHeight = () => setVisibleViewportHeightPx(Math.floor(viewport.height));
		updateVisibleHeight();
		viewport.addEventListener("resize", updateVisibleHeight);
		return () => viewport.removeEventListener("resize", updateVisibleHeight);
	}, [isEnabled]);
	const focusedViewIdentity = JSON.stringify([focusedTaskIdentity, isEnabled]);
	const idleCollapseController = useMobileFocusViewIdleCollapseController({
		enabled: isEnabled && isDocumentVisible,
		focusedTaskIdentity: focusedViewIdentity,
		focusViewRootRef,
	});
	const idleCollapseRequestSequenceNumber = idleCollapseController.idleCollapseRequestSequenceNumber;
	const [regionExpansionState, setRegionExpansionState] = useState({
		focusedViewIdentity,
		idleCollapseRequestSequenceNumber,
		upperNavigationAndToolsExpanded: true,
		lowerVirtualKeyBarExpanded: true,
	});
	useEffect(() => {
		setRegionExpansionState((previous) => {
			if (previous.focusedViewIdentity !== focusedViewIdentity)
				return {
					focusedViewIdentity,
					idleCollapseRequestSequenceNumber,
					upperNavigationAndToolsExpanded: true,
					lowerVirtualKeyBarExpanded: true,
				};
			if (previous.idleCollapseRequestSequenceNumber !== idleCollapseRequestSequenceNumber)
				return {
					focusedViewIdentity,
					idleCollapseRequestSequenceNumber,
					upperNavigationAndToolsExpanded: false,
					lowerVirtualKeyBarExpanded: false,
				};
			return previous;
		});
	}, [focusedViewIdentity, idleCollapseRequestSequenceNumber]);
	const upperNavigationAndToolsExpanded =
		regionExpansionState.focusedViewIdentity !== focusedViewIdentity ||
		regionExpansionState.upperNavigationAndToolsExpanded;
	const lowerVirtualKeyBarExpanded =
		regionExpansionState.focusedViewIdentity !== focusedViewIdentity ||
		regionExpansionState.lowerVirtualKeyBarExpanded;
	const updateIndependentRegionExpansion = useCallback(
		(
			collapsibleRegionName: "upperNavigationAndToolsExpanded" | "lowerVirtualKeyBarExpanded",
			requestedExpanded?: boolean,
		) => {
			idleCollapseController.recordUserInteraction();
			setRegionExpansionState((previous) => {
				const current =
					previous.focusedViewIdentity === focusedViewIdentity
						? previous
						: {
								focusedViewIdentity,
								idleCollapseRequestSequenceNumber,
								upperNavigationAndToolsExpanded: true,
								lowerVirtualKeyBarExpanded: true,
							};
				return { ...current, [collapsibleRegionName]: requestedExpanded ?? !current[collapsibleRegionName] };
			});
		},
		[focusedViewIdentity, idleCollapseRequestSequenceNumber, idleCollapseController.recordUserInteraction],
	);
	const toggleUpperNavigationAndTools = useCallback(
		() => updateIndependentRegionExpansion("upperNavigationAndToolsExpanded"),
		[updateIndependentRegionExpansion],
	);
	const expandLowerVirtualKeyBar = useCallback(
		() => updateIndependentRegionExpansion("lowerVirtualKeyBarExpanded", true),
		[updateIndependentRegionExpansion],
	);
	const collapseLowerVirtualKeyBar = useCallback(
		() => updateIndependentRegionExpansion("lowerVirtualKeyBarExpanded", false),
		[updateIndependentRegionExpansion],
	);
	return {
		isEnabled,
		visibleViewportHeightPx: isEnabled ? visibleViewportHeightPx : undefined,
		focusViewRootRef,
		idleCollapseController,
		upperNavigationAndToolsExpanded,
		lowerVirtualKeyBarExpanded,
		toggleUpperNavigationAndTools,
		expandLowerVirtualKeyBar,
		collapseLowerVirtualKeyBar,
	};
}
