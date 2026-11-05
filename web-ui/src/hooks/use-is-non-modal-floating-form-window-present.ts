import { useEffect, useState } from "react";
import { useNonModalFloatingFormWindowHost } from "@/components/non-modal-floating-form-window-host-provider";

/** 前台展开视图和 PDV 面板共用浮窗层级判据，独立 portal 宿主也能发现已存在的填写窗口。 */
export function useIsNonModalFloatingFormWindowPresent() {
	const host = useNonModalFloatingFormWindowHost();
	const [hasStandaloneWindow, setHasStandaloneWindow] = useState(
		() => document.querySelector("[data-non-modal-floating-form-window]") !== null,
	);
	useEffect(() => {
		if (host) return;
		const update = () =>
			setHasStandaloneWindow(document.querySelector("[data-non-modal-floating-form-window]") !== null);
		update();
		const observer = new MutationObserver(update);
		observer.observe(document.body, { childList: true });
		return () => observer.disconnect();
	}, [host]);
	return host?.hasOpenWindows ?? hasStandaloneWindow;
}
