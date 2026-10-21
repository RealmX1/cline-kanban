import { useCallback, useRef, useState } from "react";
import {
	type FocusViewDesktopPanelArrangementPreference,
	loadFocusViewDesktopPanelArrangementPreference,
	resolveFocusViewDesktopPanelArrangement,
} from "@/resize/focus-view-desktop-panel-arrangement";
import { useLayoutResetEffect } from "@/resize/layout-customizations";
import { LocalStorageKey, writeLocalStorageItem } from "@/storage/local-storage-store";
import { useWindowEvent } from "@/utils/react-use";

export function useFocusViewDesktopPanelArrangement() {
	const [preference, setPreferenceState] = useState(loadFocusViewDesktopPanelArrangementPreference);

	const [automaticArrangement, setAutomaticArrangement] = useState(() =>
		resolveFocusViewDesktopPanelArrangement("automatic", window.innerWidth, window.innerHeight),
	);
	const lastObservedAutomaticArrangement = useRef(automaticArrangement);
	useWindowEvent(
		"resize",
		useCallback(() => {
			const next = resolveFocusViewDesktopPanelArrangement("automatic", window.innerWidth, window.innerHeight);
			// 像素尺寸由各面板的 ResizeObserver 处理；这里仅在布局方向变化时通知消费者。
			if (next === lastObservedAutomaticArrangement.current) return;
			lastObservedAutomaticArrangement.current = next;
			setAutomaticArrangement(next);
		}, []),
	);

	const setPreference = useCallback((value: FocusViewDesktopPanelArrangementPreference) => {
		setPreferenceState(value);
		writeLocalStorageItem(LocalStorageKey.FocusViewDesktopPanelArrangementPreference, value);
	}, []);
	useLayoutResetEffect(() => setPreferenceState("automatic"));
	return {
		preference,
		setPreference,
		arrangement: preference === "automatic" ? automaticArrangement : preference,
	};
}
