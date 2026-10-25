import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { showAppToast } from "@/components/app-toaster";
import type { PostDeployVerificationEntryNavigationRequest } from "@/components/post-deploy-verification/post-deploy-verification-entry-navigation-host-context";
import type { SelectedBoardOrSingleProjectScope } from "@/hooks/use-selected-board-or-single-project-scope";
import type { RuntimePostDeployVerificationEntryNavigationTarget, RuntimeProjectSummary } from "@/runtime/types";

export function usePostDeployVerificationEntryNavigation(input: {
	projects: readonly RuntimeProjectSummary[];
	currentWorkspaceId: string | null;
	selectedBoardOrSingleProjectScope: SelectedBoardOrSingleProjectScope;
}) {
	const [navigation, setNavigation] = useState<{
		request: PostDeployVerificationEntryNavigationRequest;
		located: boolean;
	} | null>(null);
	const nextRequestId = useRef(0);
	const currentProjects = useRef(input.projects);
	currentProjects.current = input.projects;
	const currentNavigationIntent = useRef<AbortController | null>(null);
	const clearNavigation = useCallback(() => {
		currentNavigationIntent.current?.abort();
		currentNavigationIntent.current = null;
		setNavigation(null);
	}, []);
	useLayoutEffect(clearNavigation, [
		input.currentWorkspaceId,
		input.selectedBoardOrSingleProjectScope,
		clearNavigation,
	]);
	useEffect(() => () => currentNavigationIntent.current?.abort(), []);
	const beginNavigationIntent = useCallback(() => {
		currentNavigationIntent.current?.abort();
		// 查询期间保留已打开的跨项目面板，避免来源按钮随面板换绑而卸载。
		setNavigation((previous) => (previous ? { ...previous, located: true } : null));
		const intent = new AbortController();
		currentNavigationIntent.current = intent;
		return intent.signal;
	}, []);
	const requestNavigation = useCallback(
		(target: RuntimePostDeployVerificationEntryNavigationTarget, navigationIntent?: AbortSignal) => {
			const intent = navigationIntent ?? beginNavigationIntent();
			if (intent.aborted || intent !== currentNavigationIntent.current?.signal) return false;
			const project = currentProjects.current.find((project) => project.id === target.entry.workspaceId);
			if (project?.availability.status !== "available") {
				showAppToast({ intent: "warning", message: "来源项目暂不可用，恢复可用后可再次定位。" });
				return false;
			}
			setNavigation({ request: { requestId: ++nextRequestId.current, target }, located: false });
			return true;
		},
		[beginNavigationIntent],
	);
	const finishNavigation = useCallback((requestId: number) => {
		setNavigation((previous) =>
			previous?.request.requestId === requestId ? { ...previous, located: true } : previous,
		);
	}, []);
	useEffect(() => {
		if (!navigation || navigation.located) return;
		const timeout = window.setTimeout(
			() =>
				showAppToast({
					intent: "warning",
					message: "部署后验证面板仍在等待项目数据；数据恢复后会继续定位，也可再次点击 PDV 重试。",
				}),
			15_000,
		);
		return () => window.clearTimeout(timeout);
	}, [navigation]);
	return {
		beginNavigationIntent,
		requestNavigation,
		clearNavigation,
		finishNavigation,
		explicitEntryNavigationWorkspaceId: navigation?.request.target.entry.workspaceId ?? null,
		entryNavigationRequest: navigation && !navigation.located ? navigation.request : null,
	};
}
