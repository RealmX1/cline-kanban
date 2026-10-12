import { useCallback, useMemo, useState } from "react";

import { showAppToast } from "@/components/app-toaster";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeHostRemoteEditorAccessIdentity } from "@/runtime/types";
import { useWorkspaceOpenTargetPreferredApplicationIdPreference } from "@/runtime/use-user-interface-preferences-shared-across-browser-origins";
import { openRuntimeHostPathInEditorOnThisDeviceThroughRemoteSsh } from "@/utils/open-runtime-host-path-in-editor-on-this-device-through-remote-ssh";
import {
	buildOpenCommand,
	getOpenTargetOption,
	getOpenTargetOptions,
	getRemoteSshOpenTargetOption,
	getRemoteSshOpenTargetOptions,
	normalizeOpenTargetId,
	type OpenTargetId,
	type OpenTargetOption,
	resolveOpenTargetPlatform,
} from "@/utils/open-targets";
import { resolveProjectFilesystemAccessRouteForBrowser } from "@/utils/resolve-project-filesystem-access-route-for-browser";

interface UseOpenWorkspaceParams {
	currentProjectId: string | null;
	workspacePath?: string;
	// 从其他设备访问时拼 Remote-SSH 深链要用；runtime 配置还没加载完时为 null，此时远程的 Open 不可用。
	runtimeHostRemoteEditorAccessIdentity: RuntimeHostRemoteEditorAccessIdentity | null;
}

export const REMOTE_SSH_OPEN_TARGET_OPTIONS_FOOTNOTE =
	"Opens on this device over SSH. Needs the editor's Remote-SSH extension and SSH access to the Kanban host.";

interface UseOpenWorkspaceResult {
	openTargetOptions: readonly OpenTargetOption[];
	// 显示在下拉列表底部的说明；只在从其他设备访问（走 Remote-SSH 深链）时有。
	openTargetOptionsFootnote: string | null;
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

export function useOpenWorkspace({
	currentProjectId,
	workspacePath,
	runtimeHostRemoteEditorAccessIdentity,
}: UseOpenWorkspaceParams): UseOpenWorkspaceResult {
	const opensThroughRemoteSshDeepLink =
		resolveProjectFilesystemAccessRouteForBrowser() === "remote-ssh-editor-deep-link";
	const openTargetPlatform = resolveOpenTargetPlatform();
	const openTargetOptions = useMemo(
		() =>
			opensThroughRemoteSshDeepLink ? getRemoteSshOpenTargetOptions() : getOpenTargetOptions(openTargetPlatform),
		[opensThroughRemoteSshDeepLink, openTargetPlatform],
	);
	const fallbackTargetId = openTargetOptions[0]?.id ?? "vscode";
	const [storedOpenTargetApplicationId, setStoredOpenTargetApplicationId] =
		useWorkspaceOpenTargetPreferredApplicationIdPreference(fallbackTargetId);
	// 存回来的 id 要按**当前平台**的可选集合再过一遍：换机器后（macOS → Windows）可能读到一个本机
	// 根本装不了的目标，此时回落到该平台的首选项，而不是把一个开不了的应用摆在按钮上。
	const preferredOpenTargetId = normalizeOpenTargetId(storedOpenTargetApplicationId) ?? fallbackTargetId;
	const setPreferredOpenTargetId = setStoredOpenTargetApplicationId;
	const [isOpeningWorkspace, setIsOpeningWorkspace] = useState(false);
	const selectedOpenTarget = useMemo(
		() =>
			opensThroughRemoteSshDeepLink
				? getRemoteSshOpenTargetOption(preferredOpenTargetId)
				: getOpenTargetOption(preferredOpenTargetId, openTargetPlatform),
		[opensThroughRemoteSshDeepLink, openTargetPlatform, preferredOpenTargetId],
	);
	const canOpenWorkspace = Boolean(
		currentProjectId && workspacePath && (!opensThroughRemoteSshDeepLink || runtimeHostRemoteEditorAccessIdentity),
	);

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

		if (opensThroughRemoteSshDeepLink) {
			if (!runtimeHostRemoteEditorAccessIdentity) {
				return;
			}
			openRuntimeHostPathInEditorOnThisDeviceThroughRemoteSsh({
				preferredOpenTargetId: selectedOpenTarget.id,
				runtimeHostRemoteEditorAccessIdentity,
				absolutePath: workspacePath,
			});
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
		opensThroughRemoteSshDeepLink,
		openTargetPlatform,
		runtimeHostRemoteEditorAccessIdentity,
		selectedOpenTarget.id,
		showOpenFailureToast,
		workspacePath,
	]);

	return {
		openTargetOptions,
		openTargetOptionsFootnote: opensThroughRemoteSshDeepLink ? REMOTE_SSH_OPEN_TARGET_OPTIONS_FOOTNOTE : null,
		selectedOpenTargetId: selectedOpenTarget.id,
		onSelectOpenTarget,
		onOpenWorkspace,
		canOpenWorkspace,
		isOpeningWorkspace,
	};
}
