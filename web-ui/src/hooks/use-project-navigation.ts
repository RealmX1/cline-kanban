import { useCallback, useEffect, useState } from "react";

import { notifyError, showAppToast } from "@/components/app-toaster";
import { buildProjectPathname, parseProjectIdFromPathname } from "@/hooks/app-utils";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeProjectPermanentDeletionPreview,
	RuntimeProjectPermanentDeletionRequest,
	RuntimeProjectPermanentDeletionResult,
} from "@/runtime/types";
import { useRuntimeStateStream } from "@/runtime/use-runtime-state-stream";
import { isLocalhostAccess } from "@/utils/localhost-detection";
import { useWindowEvent } from "@/utils/react-use";

const DIRECTORY_PICKER_UNAVAILABLE_MARKERS = [
	"could not open directory picker",
	'install "zenity" or "kdialog"',
	'install powershell ("powershell" or "pwsh")',
	'command "osascript" is not available',
] as const;

function isDirectoryPickerUnavailableError(message: string | null | undefined): boolean {
	if (!message) {
		return false;
	}
	const normalized = message.trim().toLowerCase();
	if (!normalized) {
		return false;
	}
	return DIRECTORY_PICKER_UNAVAILABLE_MARKERS.some((marker) => normalized.includes(marker));
}

interface UseProjectNavigationInput {
	onProjectSwitchStart: () => void;
}

export interface UseProjectNavigationResult {
	requestedProjectId: string | null;
	navigationCurrentProjectId: string | null;
	permanentlyDeletingProjectId: string | null;
	isAddProjectDialogOpen: boolean;
	setIsAddProjectDialogOpen: (open: boolean) => void;
	pendingNativeGitInitPath: string | null;
	currentProjectId: string | null;
	projects: ReturnType<typeof useRuntimeStateStream>["projects"];
	workspaceState: ReturnType<typeof useRuntimeStateStream>["workspaceState"];
	workspaceMetadata: ReturnType<typeof useRuntimeStateStream>["workspaceMetadata"];
	latestTaskChatMessage: ReturnType<typeof useRuntimeStateStream>["latestTaskChatMessage"];
	taskChatMessagesByTaskId: ReturnType<typeof useRuntimeStateStream>["taskChatMessagesByTaskId"];
	latestTaskReadyForReview: ReturnType<typeof useRuntimeStateStream>["latestTaskReadyForReview"];
	latestMcpAuthStatuses: ReturnType<typeof useRuntimeStateStream>["latestMcpAuthStatuses"];
	notificationLogByWorkspaceId: ReturnType<typeof useRuntimeStateStream>["notificationLogByWorkspaceId"];
	clineSessionContextVersion: ReturnType<typeof useRuntimeStateStream>["clineSessionContextVersion"];
	streamError: string | null;
	isRuntimeDisconnected: boolean;
	hasReceivedSnapshot: boolean;
	recheckProjectAvailability: () => void;
	hasNoProjects: boolean;
	isProjectSwitching: boolean;
	handleSelectProject: (projectId: string) => void;
	handleAddProject: () => void;
	handleAddProjectSuccess: (projectId: string) => void;
	handleGetPermanentDeletionPreview: (projectId: string) => Promise<RuntimeProjectPermanentDeletionPreview | null>;
	handlePermanentlyDeleteProjectData: (
		input: RuntimeProjectPermanentDeletionRequest,
	) => Promise<RuntimeProjectPermanentDeletionResult | null>;
	resetProjectNavigationState: () => void;
}

export function useProjectNavigation({ onProjectSwitchStart }: UseProjectNavigationInput): UseProjectNavigationResult {
	const [requestedProjectId, setRequestedProjectId] = useState<string | null>(() => {
		if (typeof window === "undefined") {
			return null;
		}
		return parseProjectIdFromPathname(window.location.pathname);
	});
	const [pendingAddedProjectId, setPendingAddedProjectId] = useState<string | null>(null);
	const [permanentlyDeletingProjectId, setPermanentlyDeletingProjectId] = useState<string | null>(null);
	const [isAddProjectDialogOpen, setIsAddProjectDialogOpen] = useState(false);
	const [pendingGitInitPath, setPendingGitInitPath] = useState<string | null>(null);

	const {
		currentProjectId,
		projects,
		workspaceState,
		workspaceMetadata,
		latestTaskChatMessage,
		taskChatMessagesByTaskId,
		latestTaskReadyForReview,
		latestMcpAuthStatuses,
		notificationLogByWorkspaceId,
		clineSessionContextVersion,
		streamError,
		isRuntimeDisconnected,
		hasReceivedSnapshot,
		recheckProjectAvailability,
	} = useRuntimeStateStream(requestedProjectId);

	const hasNoProjects = hasReceivedSnapshot && projects.length === 0 && currentProjectId === null;
	const isProjectSwitching = requestedProjectId !== null && requestedProjectId !== currentProjectId && !hasNoProjects;
	const navigationCurrentProjectId = requestedProjectId ?? currentProjectId;

	const handleSelectProject = useCallback(
		(projectId: string) => {
			if (!projectId || projectId === currentProjectId) {
				return;
			}
			onProjectSwitchStart();
			setRequestedProjectId(projectId);
		},
		[currentProjectId, onProjectSwitchStart],
	);

	const handleAddProjectSuccess = useCallback(
		(projectId: string) => {
			setPendingAddedProjectId(projectId);
			handleSelectProject(projectId);
		},
		[handleSelectProject],
	);

	const handleAddProject = useCallback(async () => {
		if (!isLocalhostAccess()) {
			setIsAddProjectDialogOpen(true);
			return;
		}

		// On localhost, try the native OS file picker first for a more
		// familiar UX.  Fall back to the remote file browser dialog if the
		// native picker is unavailable (e.g. headless / Docker).
		try {
			const trpcClient = getRuntimeTrpcClient(currentProjectId);
			const picked = await trpcClient.projects.pickDirectory.mutate();

			if (picked.ok && picked.path) {
				const added = await trpcClient.projects.add.mutate({ path: picked.path });
				if (!added.ok || !added.project) {
					if (added.requiresGitInitialization) {
						// Needs git init — open the dialog with the path
						// pre-filled so the user can confirm initialization.
						setPendingGitInitPath(picked.path);
						setIsAddProjectDialogOpen(true);
						return;
					}
					throw new Error(added.error ?? "Could not add project.");
				}
				handleAddProjectSuccess(added.project.id);
				return;
			}
			if (!picked.ok && picked.error === "No directory was selected.") {
				// User cancelled — do nothing
				return;
			}
			if (!picked.ok && isDirectoryPickerUnavailableError(picked.error)) {
				// Native picker not available — fall back to dialog
				setIsAddProjectDialogOpen(true);
				return;
			}
			throw new Error(picked.error ?? "Could not pick project directory.");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (isDirectoryPickerUnavailableError(message)) {
				setIsAddProjectDialogOpen(true);
			} else {
				showAppToast({ intent: "danger", icon: "warning-sign", message, timeout: 7000 });
			}
		}
	}, [currentProjectId, handleAddProjectSuccess]);

	const handleGetPermanentDeletionPreview = useCallback(
		async (projectId: string): Promise<RuntimeProjectPermanentDeletionPreview | null> => {
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const payload = await trpcClient.projects.getPermanentDeletionPreview.query({ projectId });
				if (!payload.ok) {
					throw new Error(payload.error);
				}
				return payload.preview;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notifyError(message);
				return null;
			}
		},
		[currentProjectId],
	);

	const handlePermanentlyDeleteProjectData = useCallback(
		async (input: RuntimeProjectPermanentDeletionRequest): Promise<RuntimeProjectPermanentDeletionResult | null> => {
			if (permanentlyDeletingProjectId) {
				return null;
			}
			setPermanentlyDeletingProjectId(input.projectId);
			try {
				const trpcClient = getRuntimeTrpcClient(currentProjectId);
				const result = await trpcClient.projects.permanentlyDeleteProjectData.mutate(input);
				if (
					currentProjectId === input.projectId &&
					(result.status === "completed" || result.status === "completed_with_retained_staging_directory")
				) {
					onProjectSwitchStart();
					setRequestedProjectId(null);
				}
				return result;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notifyError(message);
				return null;
			} finally {
				setPermanentlyDeletingProjectId((current) => (current === input.projectId ? null : current));
			}
		},
		[currentProjectId, onProjectSwitchStart, permanentlyDeletingProjectId],
	);

	const handlePopState = useCallback(() => {
		if (typeof window === "undefined") {
			return;
		}
		const nextProjectId = parseProjectIdFromPathname(window.location.pathname);
		setRequestedProjectId(nextProjectId);
	}, []);
	useWindowEvent("popstate", handlePopState);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		if (!currentProjectId) {
			return;
		}
		const nextUrl = new URL(window.location.href);
		const nextPathname = buildProjectPathname(currentProjectId);
		if (nextUrl.pathname === nextPathname) {
			return;
		}
		window.history.replaceState({}, "", `${nextPathname}${nextUrl.search}${nextUrl.hash}`);
	}, [currentProjectId]);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		if (!hasNoProjects || !requestedProjectId) {
			return;
		}
		const nextUrl = new URL(window.location.href);
		if (nextUrl.pathname !== "/") {
			window.history.replaceState({}, "", `/${nextUrl.search}${nextUrl.hash}`);
		}
		setRequestedProjectId(null);
	}, [hasNoProjects, requestedProjectId]);

	useEffect(() => {
		if (!pendingAddedProjectId) {
			return;
		}
		const projectExists = projects.some((project) => project.id === pendingAddedProjectId);
		if (!projectExists && currentProjectId !== pendingAddedProjectId) {
			return;
		}
		setPendingAddedProjectId(null);
	}, [currentProjectId, pendingAddedProjectId, projects]);

	useEffect(() => {
		if (!requestedProjectId || !currentProjectId) {
			return;
		}
		if (pendingAddedProjectId && requestedProjectId === pendingAddedProjectId) {
			return;
		}
		const requestedStillExists = projects.some((project) => project.id === requestedProjectId);
		if (requestedStillExists) {
			return;
		}
		setRequestedProjectId(currentProjectId);
	}, [currentProjectId, pendingAddedProjectId, projects, requestedProjectId]);

	const resetProjectNavigationState = useCallback(() => {
		setPermanentlyDeletingProjectId(null);
		setIsAddProjectDialogOpen(false);
		setPendingGitInitPath(null);
	}, []);

	return {
		requestedProjectId,
		navigationCurrentProjectId,
		permanentlyDeletingProjectId,
		isAddProjectDialogOpen,
		setIsAddProjectDialogOpen,
		pendingNativeGitInitPath: pendingGitInitPath,
		currentProjectId,
		projects,
		workspaceState,
		workspaceMetadata,
		latestTaskChatMessage,
		taskChatMessagesByTaskId,
		latestTaskReadyForReview,
		latestMcpAuthStatuses,
		notificationLogByWorkspaceId,
		clineSessionContextVersion,
		streamError,
		isRuntimeDisconnected,
		hasReceivedSnapshot,
		recheckProjectAvailability,
		hasNoProjects,
		isProjectSwitching,
		handleSelectProject,
		handleAddProject,
		handleAddProjectSuccess,
		handleGetPermanentDeletionPreview,
		handlePermanentlyDeleteProjectData,
		resetProjectNavigationState,
	};
}
