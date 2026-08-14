import { useCallback, useMemo, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import { useWorkspaceOpenTargetPreferredApplicationIdPreference } from "@/runtime/use-user-interface-preferences-shared-across-browser-origins";
import {
	buildOpenCommand,
	getOpenTargetOption,
	getOpenTargetOptions,
	normalizeOpenTargetId,
	type OpenTargetId,
	type OpenTargetOption,
	resolveOpenTargetPlatform,
} from "@/utils/open-targets";

interface UseOpenWorkspaceParams {
	currentProjectId: string | null;
	workspacePath?: string;
}

interface UseOpenWorkspaceResult {
	openTargetOptions: readonly OpenTargetOption[];
	selectedOpenTargetId: OpenTargetId;
	onSelectOpenTarget: (targetId: OpenTargetId) => void;
	onOpenWorkspace: () => void;
	canOpenWorkspace: boolean;
	isOpeningWorkspace: boolean;
}

function getFirstOutputLine(output: string): string | null {
	return (
		output
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) ?? null
	);
}

export function useOpenWorkspace({ currentProjectId, workspacePath }: UseOpenWorkspaceParams): UseOpenWorkspaceResult {
	const openTargetPlatform = resolveOpenTargetPlatform();
	const openTargetOptions = useMemo(() => getOpenTargetOptions(openTargetPlatform), [openTargetPlatform]);
	const fallbackTargetId = openTargetOptions[0]?.id ?? "vscode";
	const [storedOpenTargetApplicationId, setStoredOpenTargetApplicationId] =
		useWorkspaceOpenTargetPreferredApplicationIdPreference(fallbackTargetId);
	// 存回来的 id 要按**当前平台**的可选集合再过一遍：换机器后（macOS → Windows）可能读到一个本机
	// 根本装不了的目标，此时回落到该平台的首选项，而不是把一个开不了的应用摆在按钮上。
	const preferredOpenTargetId = normalizeOpenTargetId(storedOpenTargetApplicationId) ?? fallbackTargetId;
	const setPreferredOpenTargetId = setStoredOpenTargetApplicationId;
	const [isOpeningWorkspace, setIsOpeningWorkspace] = useState(false);
	const selectedOpenTarget = useMemo(
		() => getOpenTargetOption(preferredOpenTargetId, openTargetPlatform),
		[openTargetPlatform, preferredOpenTargetId],
	);
	const canOpenWorkspace = Boolean(currentProjectId && workspacePath);

	const onSelectOpenTarget = useCallback(
		(targetId: OpenTargetId) => {
			if (!openTargetOptions.some((option) => option.id === targetId)) {
				return;
			}
			setPreferredOpenTargetId(targetId);
		},
		[openTargetOptions, setPreferredOpenTargetId],
	);

	const showOpenFailureToast = useCallback(
		(message: string) => {
			showAppToast(
				{
					intent: "danger",
					icon: "error",
					message: `Could not open in ${selectedOpenTarget.label}: ${message}`,
					timeout: 6000,
				},
				"open-workspace-failed",
			);
		},
		[selectedOpenTarget.label],
	);

	const onOpenWorkspace = useCallback(() => {
		if (isOpeningWorkspace || !currentProjectId || !workspacePath) {
			return;
		}

		void (async () => {
			setIsOpeningWorkspace(true);
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.runtime.runCommand.mutate({
					command: buildOpenCommand(selectedOpenTarget.id, workspacePath, openTargetPlatform),
				});
				if (payload.exitCode !== 0) {
					const details = getFirstOutputLine(payload.combinedOutput) ?? `Exited with code ${payload.exitCode}.`;
					showOpenFailureToast(details);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				showOpenFailureToast(message);
			} finally {
				setIsOpeningWorkspace(false);
			}
		})();
	}, [
		currentProjectId,
		isOpeningWorkspace,
		openTargetPlatform,
		selectedOpenTarget.id,
		showOpenFailureToast,
		workspacePath,
	]);

	return {
		openTargetOptions,
		selectedOpenTargetId: selectedOpenTarget.id,
		onSelectOpenTarget,
		onOpenWorkspace,
		canOpenWorkspace,
		isOpeningWorkspace,
	};
}
