import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileFocusedTaskCardHeader } from "@/components/detail-panels/mobile-focused-task-card-header";
import type { TaskCardBusinessProps } from "@/components/task-card-body";

const renderTaskCard = vi.hoisted(() => vi.fn());
vi.mock("@/components/task-card-body", () => ({
	TaskCardBody: (props: TaskCardBusinessProps) => {
		renderTaskCard(props);
		return <div data-card-body="">{props.card.title}</div>;
	},
}));

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe("手机顶部当前任务卡", () => {
	let host: HTMLDivElement;
	let root: Root;
	let sequenceNumber = 0;
	const recordUserInteraction = vi.fn();
	const card = {
		id: "task-1",
		title: "当前任务",
		prompt: "原始需求",
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
	const render = (title = card.title) =>
		act(() =>
			root.render(
				<MobileFocusedTaskCardHeader
					cardBusinessProps={{ card: { ...card, title }, columnId: "review" }}
					stageDisplayName="Review"
					idleCollapseController={{ idleCollapseRequestSequenceNumber: sequenceNumber, recordUserInteraction }}
				/>,
			),
		);
	beforeEach(() => {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		sequenceNumber = 0;
		vi.clearAllMocks();
		render();
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	});

	it("默认展示完整卡体，手动收起后保留标题、阶段与展开入口", () => {
		expect(host.querySelector("[data-card-body]")).not.toBeNull();
		act(() => host.querySelector<HTMLButtonElement>("[aria-label='收起任务卡']")!.click());
		expect(host.querySelector("[data-card-body]")).toBeNull();
		expect(host.textContent).toContain("当前任务");
		expect(host.textContent).toContain("Review");
		act(() => host.querySelector<HTMLButtonElement>("[aria-label='展开任务卡']")!.click());
		expect(host.querySelector("[data-card-body]")).not.toBeNull();
		expect(recordUserInteraction).toHaveBeenCalled();
	});

	it("消费共用收起通知，卡片内容更新不会自动重新展开", () => {
		sequenceNumber = 1;
		render();
		expect(host.querySelector("[data-card-body]")).toBeNull();
		render("推流更新后的标题");
		expect(host.textContent).toContain("推流更新后的标题");
		expect(host.querySelector("[data-card-body]")).toBeNull();
	});

	it("把真实业务 props 交给手机专用副本角色", () => {
		expect(renderTaskCard).toHaveBeenLastCalledWith(
			expect.objectContaining({
				card: expect.objectContaining({ id: "task-1" }),
				renderRole: "focused_task_card_copy_in_mobile_detail_header",
			}),
		);
	});
});
