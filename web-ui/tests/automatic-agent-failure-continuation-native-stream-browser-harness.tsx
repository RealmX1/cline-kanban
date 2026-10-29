import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BoardScopeAllProjectsHomePageCrossProjectTaskSwitcherSectionColumnsBoard } from "../src/components/board-scope-all-projects-home-page-cross-project-task-switcher-section-columns-board";
import { AutomaticAgentFailureContinuationNotice } from "../src/components/automatic-agent-failure-continuation-notice";
import { CrossProjectRecentlyActiveTaskSwitcherPanel } from "../src/components/detail-panels/cross-project-recently-active-task-switcher-panel";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { useCrossProjectRecentlyActiveTaskSwitcherHost } from "../src/hooks/use-cross-project-recently-active-task-switcher-host";
import { useCrossProjectRecentlyActiveTaskSwitcherSections } from "../src/hooks/use-cross-project-recently-active-task-switcher-sections";
import type { RuntimeProjectSummary, RuntimeTaskSessionSummary } from "../src/runtime/types";
import "../src/styles/globals.css";

function Harness() {
	const [projects, setProjects] = useState<RuntimeProjectSummary[]>([]);
	useEffect(() => {
		const url = new URL(location.href).searchParams.get("stream");
		if (!url) throw new Error("缺少隔离状态流地址");
		const socket = new WebSocket(url);
		socket.onmessage = event => {
			const message = JSON.parse(event.data);
			if (message.type === "snapshot" || message.type === "projects_updated") setProjects(message.projects);
		};
		return () => socket.close();
	}, []);
	const sections = useCrossProjectRecentlyActiveTaskSwitcherSections({ projects, notificationLogByWorkspaceId: {}, currentProjectId: null });
	const { crossProjectRecentlyActiveTaskSwitcherHost: host } = useCrossProjectRecentlyActiveTaskSwitcherHost({
		crossProjectTaskSwitcherSectionsModel: sections, projects, notificationLogByWorkspaceId: {}, currentProjectId: null,
		isBoardScopeAllProjectsSelected: true, selectedCardTaskId: null, pendingCrossProjectTaskOpen: null,
		onOpenTaskInProject: () => {}, onOpenBacklogTaskEditorInProject: () => {}, onRequestCreateTaskInBoardScope: () => {},
		onRequestPinCurrentProjectTaskToTaskPinboard: () => {}, onUnpinCurrentProjectTaskFromTaskPinboard: () => {},
		onEditCurrentProjectTaskPinboardPinReason: () => {},
	});
	const entry = projects[0]?.crossProjectTaskSwitcherEntries[0];
	const summary: RuntimeTaskSessionSummary | undefined = entry ? {
		...entry, state: "running", turnOwner: entry.turnOwner ?? "agent", workspacePath: projects[0].path,
		pid: null, startedAt: entry.createdAt, updatedAt: entry.createdAt, reviewReason: null, exitCode: null,
		lastHookAt: null, latestHookActivity: null,
	} : undefined;
	return <TooltipProvider><main className="min-h-screen bg-surface-0 p-3 text-text-primary"
		data-native-capacity-browser-phase={entry?.automaticAgentFailureContinuation?.phase ?? "none"}>
		<section data-native-capacity-browser-host="home" className="flex h-[480px] min-w-0 flex-col overflow-hidden">
			<BoardScopeAllProjectsHomePageCrossProjectTaskSwitcherSectionColumnsBoard host={host} currentProjectTaskCards={null} defaultAgentId="codex" />
		</section>
		<section data-native-capacity-browser-host="focus" className="mt-4 flex h-[350px] max-w-sm flex-col overflow-hidden">
			<h2>Focus View</h2><CrossProjectRecentlyActiveTaskSwitcherPanel host={host} currentProjectTaskCards={null} defaultAgentId="codex" />
		</section>
		<AutomaticAgentFailureContinuationNotice summary={summary} workspaceId={projects[0]?.id ?? null} executionForbidden={false} />
	</main></TooltipProvider>;
}
createRoot(document.body).render(<Harness />);
