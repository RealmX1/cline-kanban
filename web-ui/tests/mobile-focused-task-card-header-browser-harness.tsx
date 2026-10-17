import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MobileFocusedTaskCardHeader } from "../src/components/detail-panels/mobile-focused-task-card-header";
import { buildTaskCardBusinessProps } from "../src/components/task-card-business-props";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { useIsMobile } from "../src/hooks/use-is-mobile";
import {
	MobileFocusViewIdleCollapseControllerProvider,
	useMobileFocusViewIdleCollapseController,
	useSharedMobileFocusViewIdleCollapseController,
} from "../src/hooks/use-mobile-focus-view-idle-collapse-controller";
import type { RuntimeTaskSessionSummary } from "../src/runtime/types";
import { setTaskWorkspaceSnapshot } from "../src/stores/workspace-metadata-store";
import type { BoardCard } from "../src/types";
import "../src/styles/globals.css";

const directoryPath = `/Users/example/${"very-long-project-directory-name/".repeat(5)}`;
for (const taskId of ["mobile-task-1", "mobile-task-2"]) {
	setTaskWorkspaceSnapshot({
		taskId,
		path: directoryPath,
		changedFiles: 3,
		additions: 12,
		deletions: 4,
		commitsAheadOfBaseRef: 2,
		commitsBehindBaseRef: 0,
	});
}

function SharedIdleCollapseProbe() {
	const controller = useSharedMobileFocusViewIdleCollapseController();
	return <output data-shared-idle-collapse-sequence="">{controller?.idleCollapseRequestSequenceNumber ?? 0}</output>;
}

function Harness() {
	const isMobile = useIsMobile();
	const [taskId, setTaskId] = useState("mobile-task-1");
	const [title, setTitle] = useState(
		"手机 Focus View 顶部展示完整任务卡并保留元数据与操作入口 LongUnbreakableTaskIdentifier".repeat(2),
	);
	const [actionResult, setActionResult] = useState("");
	const [activity, setActivity] = useState("正在核对手机布局和实时元数据");
	const [activeTab, setActiveTab] = useState("Chat");
	const focusViewRootRef = useRef<HTMLDivElement>(null);
	const idleCollapseController = useMobileFocusViewIdleCollapseController({
		enabled: isMobile,
		focusedTaskIdentity: taskId,
		focusViewRootRef,
	});
	const now = Date.now();
	const card: BoardCard = {
		id: taskId,
		title,
		prompt: "手机上的原始任务需求",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: now - 3_600_000,
		updatedAt: now,
		agentId: "codex",
		pinnedToTaskPinboardAt: now - 60_000,
	};
	const summary: RuntimeTaskSessionSummary = {
		taskId,
		state: "running",
		agentId: "codex",
		workspacePath: directoryPath,
		pid: 1,
		startedAt: now - 600_000,
		updatedAt: now,
		lastOutputAt: now,
		reviewReason: null,
		exitCode: null,
		lastHookAt: now,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		turnOwner: "agent",
		liveness: "live",
		userTurnKind: null,
		latestHookActivity: {
			activityText: activity,
			toolName: "Read",
			toolInputSummary: null,
			finalMessage: null,
			hookEventName: "PostToolUse",
			notificationType: null,
			source: "codex",
		},
		agentResponseGenerationStopped: {
			stoppedAt: now - 300_000,
			signalConfidence: "harness_turn_complete",
			turnSequence: 1,
		},
		lastConversationProgressObservation: { observedAtMs: now - 60_000, evidenceKind: "agent_lifecycle_hook_event" },
	};
	return (
		<TooltipProvider>
			<div className="flex h-dvh flex-col overflow-hidden bg-surface-0 text-text-primary">
				<header className="flex h-11 shrink-0 items-center px-3 text-sm">Kanban · 手机布局验证</header>
				<MobileFocusViewIdleCollapseControllerProvider value={idleCollapseController}>
					<div
						ref={focusViewRootRef}
						data-focus-view-browser-root=""
						className="flex min-h-0 flex-1 flex-col overflow-hidden"
					>
						{isMobile ? (
							<MobileFocusedTaskCardHeader
								key={taskId}
								stageDisplayName="Review"
								idleCollapseController={idleCollapseController}
								cardBusinessProps={buildTaskCardBusinessProps({
									card,
									selected: true,
									columnId: "review",
									sessionSummary: summary,
									workspacePath: "/Users/example/project",
									handlers: {
										onSaveTitle: (_id, value) => setTitle(value),
										onMoveToValidationTask: (id) => setActionResult(`validation:${id}`),
										onMoveToTrashTask: (id) => setActionResult(`done:${id}`),
										onUnpinFromTaskPinboard: (id) => setActionResult(`unpin:${id}`),
										onDeleteTask: (id) => setActionResult(`delete:${id}`),
									},
								})}
							/>
						) : (
							<div data-desktop-layout="">桌面任务列表</div>
						)}
						<nav aria-label="验证页签" className="flex h-11 shrink-0 overflow-x-auto border-b border-divider">
							{["Chat", "Sessions", "Prompts", "Commands"].map((tab) => (
								<button
									key={tab}
									type="button"
									className="min-h-[44px] shrink-0 px-3"
									onClick={() => setActiveTab(tab)}
								>
									{tab}
								</button>
							))}
						</nav>
						<main data-agent-content="" className="min-h-0 flex-1 overflow-y-auto p-3">
							<p>{activeTab}：Agent 会话区</p>
							<input aria-label="Agent 输入" className="mt-2 w-full border border-border bg-surface-2 p-2" />
							<button
								type="button"
								className="min-h-[44px] px-3"
								onClick={() => setTaskId((id) => (id === "mobile-task-1" ? "mobile-task-2" : "mobile-task-1"))}
							>
								切换任务
							</button>
							<button type="button" className="min-h-[44px] px-3" onClick={() => setActivity("实时活动已更新")}>
								更新活动
							</button>
							<output aria-label="动作结果">{actionResult}</output>
							<SharedIdleCollapseProbe />
						</main>
					</div>
				</MobileFocusViewIdleCollapseControllerProvider>
			</div>
		</TooltipProvider>
	);
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<Harness />);
