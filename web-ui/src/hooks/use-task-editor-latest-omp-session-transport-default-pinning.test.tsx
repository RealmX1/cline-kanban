import { act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useTaskEditor } from "@/hooks/use-task-editor";
import type { RuntimeAgentId, RuntimeAgentSessionTransport } from "@/runtime/types";
import type { BoardCard, BoardData } from "@/types";

/**
 * 钉住「omp 新任务默认通道」的**新鲜度**。该全局默认的语义是严格的「新任务默认值」：
 * 建卡那一刻固化到卡上、之后改全局不追溯已有卡片。正因为只有建卡那一瞬间读一次，
 * 建卡 callback 必须读到用户此刻的设置，读到闭包里捕获的上一次的值就是永久性的错值。
 *
 * 这里刻意跑「只改全局默认、其余输入一律不动」的渲染序列：先把草稿备齐，再单独切全局默认，
 * 于是建卡 callback 的其它依赖全都没变。全局默认一旦漏出 useCallback 依赖数组，
 * React 就会复用旧闭包，新建的卡被写成切换前的通道——本文件的用例就会红。
 * 单独成文件而不并进 use-task-editor.test.tsx，是因为它要求对渲染时序做精确控制，
 * 与那份通用 harness「一把梭渲染再断言」的关注点不同。
 */

const CREATE_TASK_BRANCH_OPTIONS = [{ value: "main", label: "main" }];
const EDIT_TASK_BRANCH_OPTIONS = [{ value: "main", label: "main" }];

function createEmptyBoard(): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

interface TaskEditorCreateHandles {
	board: BoardData;
	handleCreateTask: () => string | null;
	handleCreateTasks: (prompts: string[]) => string[];
	setNewTaskPrompt: (value: string) => void;
	setNewTaskAgentId: (value: RuntimeAgentId | undefined) => void;
}

function TaskEditorCreateHarness({
	ompAgentSessionTransportForNewTasks,
	onRenderHandles,
}: {
	ompAgentSessionTransportForNewTasks: RuntimeAgentSessionTransport;
	onRenderHandles: (handles: TaskEditorCreateHandles) => void;
}): null {
	const [board, setBoard] = useState<BoardData>(createEmptyBoard);
	const [, setSelectedTaskId] = useState<string | null>(null);
	const editor = useTaskEditor({
		board,
		setBoard,
		createTaskBranchOptions: CREATE_TASK_BRANCH_OPTIONS,
		editTaskBranchOptions: EDIT_TASK_BRANCH_OPTIONS,
		defaultTaskBranchRef: "main",
		defaultCreateTaskBranchRef: "main",
		currentProjectId: "project-1",
		selectedAgentId: null,
		newTaskStartInPlanModeByDefault: false,
		isNewTaskStartInPlanModeDefaultLoaded: true,
		ompAgentSessionTransportForNewTasks,
		newTaskAgentPermissionModeByDefault: "bypass_all_permission_prompts",
		setSelectedTaskId,
	});

	const onRenderHandlesRef = useRef(onRenderHandles);
	onRenderHandlesRef.current = onRenderHandles;

	// 故意不给依赖数组：每次渲染后都重新交出句柄，断言拿到的才一定是**最后一次渲染**持有的那份
	// callback——包括「依赖没变、被 React 原样复用的旧闭包」这个正要测的情况。
	useEffect(() => {
		onRenderHandlesRef.current({
			board,
			handleCreateTask: editor.handleCreateTask,
			handleCreateTasks: editor.handleCreateTasks,
			setNewTaskPrompt: editor.setNewTaskPrompt,
			setNewTaskAgentId: editor.setNewTaskAgentId,
		});
	});

	return null;
}

function requireHandles(handles: TaskEditorCreateHandles | null): TaskEditorCreateHandles {
	if (!handles) {
		throw new Error("Expected the task editor harness to publish its handles.");
	}
	return handles;
}

function readBacklogCards(board: BoardData): BoardCard[] {
	return board.columns.find((column) => column.id === "backlog")?.cards ?? [];
}

// web-ui 的 BoardCard 还没声明这个字段（值由 @runtime-task-state 在建卡时写入），
// 所以就地窄化读取，而不是为了断言去给全局类型开洞。
function readPinnedOmpSessionTransport(card: BoardCard | undefined): RuntimeAgentSessionTransport | undefined {
	return (card as (BoardCard & { ompAgentSessionTransport?: RuntimeAgentSessionTransport }) | undefined)
		?.ompAgentSessionTransport;
}

describe("useTaskEditor 建卡固化的 omp 通道默认值", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		localStorage.clear();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		localStorage.clear();
	});

	it("单条建卡固化的是切换后的全局默认", async () => {
		let handles: TaskEditorCreateHandles | null = null;
		const publishHandles = (next: TaskEditorCreateHandles): void => {
			handles = next;
		};

		await act(async () => {
			root.render(
				<TaskEditorCreateHarness
					ompAgentSessionTransportForNewTasks="pty_terminal"
					onRenderHandles={publishHandles}
				/>,
			);
		});

		// 先把草稿备齐（prompt 与 agentId 都在建卡 callback 的依赖里），
		// 之后就只剩全局默认这一个变量还会动。
		await act(async () => {
			requireHandles(handles).setNewTaskPrompt("让 omp 接手这张卡");
			requireHandles(handles).setNewTaskAgentId("omp");
		});

		// 用户此刻在设置页把「omp 新任务默认通道」从 TUI 切到 ACP。
		await act(async () => {
			root.render(
				<TaskEditorCreateHarness
					ompAgentSessionTransportForNewTasks="acp_stdio_subprocess"
					onRenderHandles={publishHandles}
				/>,
			);
		});

		await act(async () => {
			requireHandles(handles).handleCreateTask();
		});

		const createdCards = readBacklogCards(requireHandles(handles).board);
		expect(createdCards).toHaveLength(1);
		expect(readPinnedOmpSessionTransport(createdCards[0])).toBe("acp_stdio_subprocess");
	});

	it("批量建卡整批固化的都是切换后的全局默认", async () => {
		let handles: TaskEditorCreateHandles | null = null;
		const publishHandles = (next: TaskEditorCreateHandles): void => {
			handles = next;
		};

		await act(async () => {
			root.render(
				<TaskEditorCreateHarness
					ompAgentSessionTransportForNewTasks="pty_terminal"
					onRenderHandles={publishHandles}
				/>,
			);
		});

		// 批量建卡的 prompt 由调用参数给，所以这里只需先定住 agentId 这个依赖。
		await act(async () => {
			requireHandles(handles).setNewTaskAgentId("omp");
		});

		await act(async () => {
			root.render(
				<TaskEditorCreateHarness
					ompAgentSessionTransportForNewTasks="acp_stdio_subprocess"
					onRenderHandles={publishHandles}
				/>,
			);
		});

		await act(async () => {
			requireHandles(handles).handleCreateTasks(["第一张 omp 卡", "第二张 omp 卡"]);
		});

		const createdCards = readBacklogCards(requireHandles(handles).board);
		expect(createdCards).toHaveLength(2);
		expect(createdCards.map((card) => readPinnedOmpSessionTransport(card))).toEqual([
			"acp_stdio_subprocess",
			"acp_stdio_subprocess",
		]);
	});
});
