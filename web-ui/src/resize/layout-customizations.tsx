import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { resetLayoutCustomizationLocalStorageItems } from "@/storage/local-storage-store";

interface LayoutCustomizationsContextValue {
	layoutResetNonce: number;
	resetLayoutCustomizations: () => void;
}

const LayoutCustomizationsContext = createContext<LayoutCustomizationsContextValue | null>(null);

export function LayoutCustomizationsProvider({
	children,
	onResetBottomTerminalLayoutCustomizations,
	onResetSidebarVisibilityLayoutCustomizations,
}: {
	children: ReactNode;
	onResetBottomTerminalLayoutCustomizations: () => void;
	onResetSidebarVisibilityLayoutCustomizations?: () => void;
}): React.ReactElement {
	const [layoutResetNonce, setLayoutResetNonce] = useState(0);

	const resetLayoutCustomizations = useCallback(() => {
		resetLayoutCustomizationLocalStorageItems();
		onResetBottomTerminalLayoutCustomizations();
		onResetSidebarVisibilityLayoutCustomizations?.();
		setLayoutResetNonce((current) => current + 1);
		showAppToast(
			{
				intent: "success",
				message: "Layout reset to defaults.",
				timeout: 3000,
			},
			"layout-reset",
		);
	}, [onResetBottomTerminalLayoutCustomizations, onResetSidebarVisibilityLayoutCustomizations]);

	const value = useMemo(
		() => ({
			layoutResetNonce,
			resetLayoutCustomizations,
		}),
		[layoutResetNonce, resetLayoutCustomizations],
	);

	return <LayoutCustomizationsContext.Provider value={value}>{children}</LayoutCustomizationsContext.Provider>;
}

export function useLayoutCustomizations(): LayoutCustomizationsContextValue {
	const value = useContext(LayoutCustomizationsContext);
	if (!value) {
		throw new Error("useLayoutCustomizations must be used within a LayoutCustomizationsProvider.");
	}
	return value;
}

export function useLayoutResetEffect(onReset: () => void): void {
	const contextValue = useContext(LayoutCustomizationsContext);
	const layoutResetNonce = contextValue?.layoutResetNonce ?? 0;
	const onResetRef = useRef(onReset);
	const hasMountedRef = useRef(false);

	useEffect(() => {
		onResetRef.current = onReset;
	}, [onReset]);

	useEffect(() => {
		if (!hasMountedRef.current) {
			hasMountedRef.current = true;
			return;
		}
		onResetRef.current();
	}, [layoutResetNonce]);
}
