import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskCardBody, type TaskCardBodyRenderRole } from "@/components/task-card-body";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BoardCard } from "@/types";

// 三种 renderRole 的行为矩阵。这里钉死的是整套 Task Pinboard 的地基：同一张卡在界面上可能同时存在多份
// DOM，而**只有** canonical 那份携带 data-task-id / data-verification-anchor。程序化拖动、依赖连线锚点
// （后出现者覆盖先出现者）、居中滚动、sticky 几何测量、Post-Deploy Verification 高亮全都以该属性唯一为前提。

const workspaceSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("@/stores/workspace-metadata-store", () => ({
	useTaskWorkspaceSnapshotValue: workspaceSnapshotMock,
	useTaskWorkspaceInfoValue: () => null,
}));

function createCard(overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: "task-1",
		title: "Review API changes",
		prompt: "Review API changes",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: Date.now() - 60_000,
		updatedAt: Date.now(),
		...overrides,
	};
}

let container: HTMLDivElement;
let root: Root;
let previousActEnvironment: boolean | undefined;

function renderCardBody(props: {
	renderRole?: TaskCardBodyRenderRole;
	card?: BoardCard;
	stageDisplayNameForTaskPinboardCopy?: string;
	onNavigateToCanonicalCardInItsStage?: () => void;
	onEditTaskPinboardPinReason?: () => void;
	onRequestPinToTaskPinboard?: (taskId: string) => void;
	onUnpinFromTaskPinboard?: (taskId: string) => void;
	onClick?: () => void;
}): HTMLDivElement {
	const { card = createCard(), ...rest } = props;
	act(() => root.render(<TaskCardBody card={card} columnId="review" {...rest} />));
	return container;
}

function cardShell(host: HTMLElement): HTMLElement | null {
	return host.querySelector<HTMLElement>(".kb-board-card-shell");
}

beforeEach(() => {
	workspaceSnapshotMock.mockReturnValue(undefined);
	previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
		.IS_REACT_ACT_ENVIRONMENT;
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.appendChild(container);
	const baseRoot = createRoot(container);
	root = {
		render: (children: ReactNode) => baseRoot.render(<TooltipProvider>{children}</TooltipProvider>),
		unmount: () => baseRoot.unmount(),
	};
});

afterEach(() => {
	act(() => root.unmount());
	vi.restoreAllMocks();
	container.remove();
	(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
		previousActEnvironment;
});

describe("TaskCardBody 的渲染角色", () => {
	it.each<TaskCardBodyRenderRole>([
		"canonical_card_in_its_stage_list",
		"focused_card_copy_under_sticky_stage_header",
		"focused_task_card_copy_in_mobile_detail_header",
		"pinned_card_copy_in_task_pinboard",
	])("Review 卡片有未提交变化时也不显示 Git 操作按钮：%s", (renderRole) => {
		workspaceSnapshotMock.mockReturnValue({ path: "/isolated/task-1", changedFiles: 2, additions: 3, deletions: 1 });
		const host = renderCardBody({ renderRole });
		const buttonLabels = Array.from(host.querySelectorAll("button"), (button) => button.textContent?.trim());
		expect(buttonLabels).not.toContain("Commit");
		expect(buttonLabels).not.toContain("Open PR");
	});

	it("只有本体卡输出 data-task-id 与 verification 锚点", () => {
		const canonical = cardShell(renderCardBody({ renderRole: "canonical_card_in_its_stage_list" }));
		expect(canonical?.getAttribute("data-task-id")).toBe("task-1");
		expect(canonical?.getAttribute("data-verification-anchor")).toBe("board-task-card:task-1");

		const stickyCopy = cardShell(renderCardBody({ renderRole: "focused_card_copy_under_sticky_stage_header" }));
		expect(stickyCopy?.getAttribute("data-task-id")).toBeNull();
		expect(stickyCopy?.getAttribute("data-verification-anchor")).toBeNull();

		const mobileHeaderCopy = cardShell(
			renderCardBody({ renderRole: "focused_task_card_copy_in_mobile_detail_header" }),
		);
		expect(mobileHeaderCopy?.getAttribute("data-task-id")).toBeNull();
		expect(mobileHeaderCopy?.getAttribute("data-verification-anchor")).toBeNull();

		const pinboardCopy = cardShell(renderCardBody({ renderRole: "pinned_card_copy_in_task_pinboard" }));
		expect(pinboardCopy?.getAttribute("data-task-id")).toBeNull();
		expect(pinboardCopy?.getAttribute("data-verification-anchor")).toBeNull();

		// PDV 面板条目：DOM 身份留在条目 wrapper 上（verification-panel-task:<taskId>），卡体副本不输出。
		const postDeployVerificationPanelEntryCopy = cardShell(
			renderCardBody({ renderRole: "task_card_copy_in_post_deploy_verification_panel_entry" }),
		);
		expect(postDeployVerificationPanelEntryCopy?.getAttribute("data-task-id")).toBeNull();
		expect(postDeployVerificationPanelEntryCopy?.getAttribute("data-verification-anchor")).toBeNull();
	});

	it("手机顶部卡片点击空白不会重新打开任务", () => {
		const onClick = vi.fn();
		const host = renderCardBody({ renderRole: "focused_task_card_copy_in_mobile_detail_header", onClick });
		act(() => cardShell(host)?.click());
		expect(onClick).not.toHaveBeenCalled();
	});

	it("PDV 面板条目副本与置顶板分身同一侧：可单击进详情（pointer）、双击改标题，不显示置顶板专属的 stage 标签", () => {
		const onSaveTitle = vi.fn();
		act(() =>
			root.render(
				<TaskCardBody
					card={createCard()}
					columnId="review"
					renderRole="task_card_copy_in_post_deploy_verification_panel_entry"
					stageDisplayNameForTaskPinboardCopy="Review"
					onClick={vi.fn()}
					onSaveTitle={onSaveTitle}
				/>,
			),
		);
		const postDeployVerificationPanelEntryCopy = cardShell(container);
		expect(postDeployVerificationPanelEntryCopy?.dataset.taskCardRenderRole).toBe(
			"task_card_copy_in_post_deploy_verification_panel_entry",
		);
		expect(postDeployVerificationPanelEntryCopy?.style.cursor).toBe("pointer");
		expect(postDeployVerificationPanelEntryCopy?.onclick).not.toBeNull();
		expect(container.querySelector("[data-task-pinboard-stage-label]")).toBeNull();
		act(() => {
			postDeployVerificationPanelEntryCopy?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
		});
		expect(container.querySelector("textarea")).not.toBeNull();
	});

	it("每份卡体都标出自己的渲染角色，供 CSS 与断言区分同名的多份 DOM", () => {
		expect(
			cardShell(renderCardBody({ renderRole: "pinned_card_copy_in_task_pinboard" }))?.dataset.taskCardRenderRole,
		).toBe("pinned_card_copy_in_task_pinboard");
		// 省略时默认本体，老调用方行为不变。
		expect(cardShell(renderCardBody({}))?.dataset.taskCardRenderRole).toBe("canonical_card_in_its_stage_list");
	});

	it("置顶板分身可单击进详情，sticky 卡头副本是只读镜像", () => {
		const onPinboardCopyClick = vi.fn();
		const pinboardCopy = cardShell(
			renderCardBody({ renderRole: "pinned_card_copy_in_task_pinboard", onClick: onPinboardCopyClick }),
		);
		act(() => {
			pinboardCopy?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
		});
		// review 是「会跳转的列」：单击延迟触发以留出双击窗口，这里只断言 handler 已被接上（未被 undefined 掉）。
		expect(pinboardCopy?.onclick).not.toBeNull();
		expect(pinboardCopy?.style.cursor).toBe("pointer");

		const stickyCopy = cardShell(
			renderCardBody({ renderRole: "focused_card_copy_under_sticky_stage_header", onClick: vi.fn() }),
		);
		expect(stickyCopy?.style.cursor).toBe("default");
	});

	it("本体卡可拖拽的光标提示保持不变", () => {
		expect(cardShell(renderCardBody({}))?.style.cursor).toBe("grab");
	});

	it("stage 标签只在置顶板分身上出现，点击回调跳回本体卡", () => {
		const onNavigateToCanonicalCardInItsStage = vi.fn();
		const pinboardCopy = renderCardBody({
			renderRole: "pinned_card_copy_in_task_pinboard",
			stageDisplayNameForTaskPinboardCopy: "Review",
			onNavigateToCanonicalCardInItsStage,
		});
		const stageLabel = pinboardCopy.querySelector<HTMLButtonElement>("[data-task-pinboard-stage-label]");
		expect(stageLabel?.textContent).toContain("Review");
		act(() => stageLabel?.click());
		expect(onNavigateToCanonicalCardInItsStage).toHaveBeenCalledTimes(1);

		const canonical = renderCardBody({ stageDisplayNameForTaskPinboardCopy: "Review" });
		expect(canonical.querySelector("[data-task-pinboard-stage-label]")).toBeNull();
	});

	it("置顶原因只在分身上铺开，本体卡上改为常驻的置顶标记", () => {
		const card = createCard({ pinnedToTaskPinboardAt: 5_000, taskPinboardPinReason: "blocked on review" });
		const onEditTaskPinboardPinReason = vi.fn();

		const pinboardCopy = renderCardBody({
			card,
			renderRole: "pinned_card_copy_in_task_pinboard",
			stageDisplayNameForTaskPinboardCopy: "Review",
			onEditTaskPinboardPinReason,
		});
		const pinReasonRow = pinboardCopy.querySelector<HTMLButtonElement>("[data-task-pinboard-pin-reason]");
		expect(pinReasonRow?.textContent).toContain("blocked on review");
		act(() => pinReasonRow?.click());
		expect(onEditTaskPinboardPinReason).toHaveBeenCalledTimes(1);
		// 置顶板里每张都是置顶的，那边不再重复常驻标记。
		expect(pinboardCopy.querySelector("[data-task-pinboard-pinned-marker]")).toBeNull();

		// 本体卡不铺开原因（否则每张卡凭空变高），改为一个常驻小标记——hover 动作组在静默态是透明的，
		// 只靠按钮的话浏览原 stage 时根本看不出哪张卡被置顶了。
		const canonical = renderCardBody({ card });
		expect(canonical.querySelector("[data-task-pinboard-pin-reason]")).toBeNull();
		expect(canonical.querySelector("[data-task-pinboard-pinned-marker]")).not.toBeNull();
	});

	it("置顶原因为空时分身退化成「添加原因」入口，编辑路径不因空原因而消失", () => {
		// 空原因是受支持的正常置顶路径（对话框只给填写机会、不设门槛）。若原因行随空原因一起消失，
		// 分身上就只剩 Unpin，用户想事后补一句原因只能 unpin 再 pin，而 re-pin 会刷新置顶时间、改变板内排序。
		const cardPinnedWithoutPinReason = createCard({ pinnedToTaskPinboardAt: 5_000 });
		const onEditTaskPinboardPinReason = vi.fn();

		const pinboardCopy = renderCardBody({
			card: cardPinnedWithoutPinReason,
			renderRole: "pinned_card_copy_in_task_pinboard",
			stageDisplayNameForTaskPinboardCopy: "Review",
			onEditTaskPinboardPinReason,
		});
		const pinReasonRow = pinboardCopy.querySelector<HTMLButtonElement>("[data-task-pinboard-pin-reason]");
		expect(pinReasonRow?.dataset.taskPinboardPinReasonState).toBe("blank_invites_adding_reason");
		expect(pinReasonRow?.textContent).toContain("Add pin reason");
		act(() => pinReasonRow?.click());
		expect(onEditTaskPinboardPinReason).toHaveBeenCalledTimes(1);

		// 空原因不是把「原因不上本体卡」这条设计意图放宽的理由：本体卡仍然一行都不铺开。
		const canonicalWithoutPinReason = renderCardBody({
			card: cardPinnedWithoutPinReason,
			onEditTaskPinboardPinReason,
		});
		expect(canonicalWithoutPinReason.querySelector("[data-task-pinboard-pin-reason]")).toBeNull();

		// 没接编辑回调的分身也不该多出一行点了没反应的假入口。
		const pinboardCopyWithoutEditHandler = renderCardBody({
			card: cardPinnedWithoutPinReason,
			renderRole: "pinned_card_copy_in_task_pinboard",
			stageDisplayNameForTaskPinboardCopy: "Review",
		});
		expect(pinboardCopyWithoutEditHandler.querySelector("[data-task-pinboard-pin-reason]")).toBeNull();
	});

	it("未置顶时 pin 按钮走「请求置顶」，已置顶时走「取消置顶」", () => {
		const onRequestPinToTaskPinboard = vi.fn();
		const onUnpinFromTaskPinboard = vi.fn();

		const unpinnedCard = renderCardBody({ onRequestPinToTaskPinboard, onUnpinFromTaskPinboard });
		act(() => unpinnedCard.querySelector<HTMLButtonElement>('[aria-label="Pin task to pinboard"]')?.click());
		expect(onRequestPinToTaskPinboard).toHaveBeenCalledWith("task-1");
		expect(onUnpinFromTaskPinboard).not.toHaveBeenCalled();

		const pinnedCard = renderCardBody({
			card: createCard({ pinnedToTaskPinboardAt: 5_000 }),
			onRequestPinToTaskPinboard,
			onUnpinFromTaskPinboard,
		});
		act(() => pinnedCard.querySelector<HTMLButtonElement>('[aria-label="Unpin task from pinboard"]')?.click());
		expect(onUnpinFromTaskPinboard).toHaveBeenCalledWith("task-1");
	});

	it("没接 pin 回调时不渲染 pin 按钮", () => {
		const host = renderCardBody({});
		expect(host.querySelector('[aria-label="Pin task to pinboard"]')).toBeNull();
		expect(host.querySelector('[aria-label="Unpin task from pinboard"]')).toBeNull();
	});
});
