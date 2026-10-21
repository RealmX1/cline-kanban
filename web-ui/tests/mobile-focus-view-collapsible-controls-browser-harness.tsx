import { Terminal } from "@xterm/xterm";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CardDetailView } from "../src/components/card-detail-view";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { useMobileFocusViewCollapsibleControls } from "../src/hooks/use-mobile-focus-view-collapsible-controls";
import type { RuntimeTaskSessionSummary } from "../src/runtime/types";
import { setTaskWorkspaceSnapshot } from "../src/stores/workspace-metadata-store";
import type { BoardCard, CardSelection } from "../src/types";
import "../src/styles/globals.css";

// 只在浏览器 fixture 捕获真实实例，避免为观测 viewportY 给生产代码新增测试接口。
const browserTestTerminals: Terminal[] = [];
const openRealTerminal = Terminal.prototype.open;
Terminal.prototype.open = function (parent: HTMLElement) {
	openRealTerminal.call(this, parent);
	browserTestTerminals.push(this);
};
declare global {
	interface Window {
		mobileFocusViewTerminalBrowserTest: {
			readScreenText: () => string;
			readViewport: () => {
				viewportY: number;
				baseY: number;
				rowHeight: number;
				bufferType: string;
				renderer: string;
			};
			setLineHeight: (lineHeight: number) => void;
		};
	}
}
window.mobileFocusViewTerminalBrowserTest = {
	readScreenText: () => {
		const buffer = browserTestTerminals[0]!.buffer.active;
		return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? "").join("\n");
	},
	readViewport: () => {
		const terminal = browserTestTerminals[0]!;
		const screen = terminal.element!.querySelector(".xterm-screen")!;
		const canvas = screen.querySelector("canvas");
		return {
			viewportY: terminal.buffer.active.viewportY,
			baseY: terminal.buffer.active.baseY,
			rowHeight: canvas
				? canvas.height / window.devicePixelRatio / terminal.rows
				: screen.getBoundingClientRect().height / terminal.rows,
			bufferType: terminal.buffer.active.type,
			renderer: canvas ? "webgl" : "dom",
		};
	},
	setLineHeight: (lineHeight) => {
		browserTestTerminals[0]!.options.lineHeight = lineHeight;
	},
};

for (const taskId of ["mobile-scroll-task-1", "mobile-scroll-task-2"]) {
	setTaskWorkspaceSnapshot({ taskId, path: `/isolated/mobile-controls/${taskId}`, changedFiles: 0, additions: 0, deletions: 0, commitsAheadOfBaseRef: 0, commitsBehindBaseRef: 0 });
}
function Harness() {
	const [taskId, setTaskId] = useState("mobile-scroll-task-1");
	const controls = useMobileFocusViewCollapsibleControls({ enabled: true, focusedTaskIdentity: `mobile-browser-test/${taskId}` });
	const now = Date.now();
	const card: BoardCard = { id: taskId, title: "独立折叠与长按加速滚动", prompt: "隔离浏览器交互验证", agentId: "codex", startInPlanMode: false, baseRef: "main", createdAt: now, updatedAt: now };
	const column = { id: "in_progress" as const, title: "In Progress", cards: [card] };
	const selection: CardSelection = { card, column, allColumns: [column] };
	const summary: RuntimeTaskSessionSummary = { taskId, agentId: "codex", state: "running", turnOwner: "agent", liveness: "live", userTurnKind: null, workspacePath: "/isolated/mobile-controls", pid: 1, startedAt: 1, updatedAt: now, lastOutputAt: now, reviewReason: null, exitCode: null, lastHookAt: null, latestHookActivity: null, latestTurnCheckpoint: null, previousTurnCheckpoint: null };
	return <TooltipProvider>
		<button type="button" hidden data-switch-browser-test-task="" onClick={() => setTaskId((id) => id.endsWith("1") ? "mobile-scroll-task-2" : "mobile-scroll-task-1")}>切换验证任务</button>
		<div ref={controls.focusViewRootRef} style={{ height: controls.visibleViewportHeightPx }} className="flex h-dvh min-w-0 flex-col overflow-hidden bg-surface-0 text-text-primary">
			<div hidden={!controls.upperNavigationAndToolsExpanded} className="shrink-0" data-mobile-focus-view-global-navigation=""><header className="flex h-11 items-center px-3">Kanban · 隔离验证</header></div>
			<CardDetailView selection={selection} currentProjectId="mobile-browser-test" workspacePath="/isolated/mobile-controls" selectedAgentId="codex" sessionSummary={summary} taskSessions={{ [taskId]: summary }} onSessionSummary={() => {}} onCardSelect={() => {}} onTaskDragEnd={() => {}} onMoveToTrash={() => {}} bottomTerminalOpen={false} bottomTerminalTaskId={null} bottomTerminalSummary={null} onBottomTerminalClose={() => {}} mobileFocusViewControls={controls} onBackToBoard={() => { document.body.dataset.returnedToBoard = "true"; }} />
		</div>
	</TooltipProvider>;
}
createRoot(document.body.appendChild(document.createElement("div"))).render(<Harness />);
