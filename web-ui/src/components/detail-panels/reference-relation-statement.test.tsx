import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReferenceRelationStatement } from "./reference-relation-statement";

let container: HTMLDivElement;
let root: Root;
const onReferenceRelationKindAndDirectionChange = vi.fn();
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	onReferenceRelationKindAndDirectionChange.mockClear();
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});
async function renderStatement(overrides: Partial<Parameters<typeof ReferenceRelationStatement>[0]> = {}) {
	await act(async () =>
		root.render(
			<ReferenceRelationStatement
				relationKind="reference_is_generally_related_with"
				currentTaskIsStatementSubject={true}
				rootTitle="修复本 Task"
				counterpartLabel="other-project / abc12 / 对端交付物"
				currentTaskTargetWorkspaceId="current-project"
				counterpartCurrentWorkspaceId="other-project"
				onReferenceRelationKindAndDirectionChange={onReferenceRelationKindAndDirectionChange}
				{...overrides}
			/>,
		),
	);
	const select = container.querySelector("select");
	if (!select) throw new Error("缺少关系及方向控件");
	return select;
}

it("新关系只给出六种语义，四种有向关系各有正反选项，无向关系不重复", async () => {
	const select = await renderStatement();
	expect([...select.options].map((option) => option.text)).toEqual([
		"普通关联（无方向，默认）",
		"修复其交付物 →",
		"← 交付物由其修复",
		"诊断其 Trajectory →",
		"← Trajectory 由其诊断",
		"复用其产物 →",
		"← 产物被其复用",
		"需求源自 →",
		"← 其需求源自本 Task",
		"跨 project 对应（无方向）",
	]);
	expect(container.querySelector('[aria-label="陈述方向"]')).toBeNull();
	expect(container.firstElementChild?.children[0]?.textContent).toBe("本 Task：修复本 Task");
	expect(container.firstElementChild?.children[2]?.textContent).toBe("已有 Task：other-project / abc12 / 对端交付物");
	expect(container.textContent).toContain("─");
});

it.each(["reference_fixes_defects_in_produced_outputs_of", "reference_diagnoses_agent_execution_trajectory_of"])(
	"%s 的反向选择回传同一个 kind 与反向角色",
	async (kind) => {
		const select = await renderStatement();
		await act(async () => {
			select.value = `${kind}:inverse`;
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(onReferenceRelationKindAndDirectionChange).toHaveBeenCalledWith(kind, false);
	},
);

it.each(["current-project", null])(
	"对端 project 为 %s 时禁用跨 project 对应",
	async (counterpartCurrentWorkspaceId) => {
		const select = await renderStatement({ counterpartCurrentWorkspaceId });
		const option = [...select.options].find(
			(option) => option.value === "reference_is_cross_repository_counterpart_with",
		);
		expect(option?.disabled).toBe(true);
		expect(option?.text).toContain("仅限不同 project");
	},
);

it("迁移后保留已选跨 project kind，不悄悄改成普通关联", async () => {
	const select = await renderStatement({
		relationKind: "reference_is_cross_repository_counterpart_with",
		counterpartCurrentWorkspaceId: "current-project",
	});
	expect(select.value).toBe("reference_is_cross_repository_counterpart_with");
	expect(select.selectedOptions[0]?.disabled).toBe(true);
	expect(onReferenceRelationKindAndDirectionChange).not.toHaveBeenCalled();
});

it("旧 kind 仅对其自身编辑开放，范围重叠仍明确按工作范围呈现", async () => {
	const select = await renderStatement({
		relationKind: "reference_concerns_behavior_or_state_of",
		assertedRelationKindSpecificAttributes: { concernNature: "checks_scope_overlap_with" },
		currentTaskIsStatementSubject: false,
	});
	expect(select.selectedOptions[0]?.text).toBe("← 工作范围重叠");
	expect([...select.options].some((option) => option.value === "reference_verifies_claims_of")).toBe(false);
	await act(async () =>
		root.render(
			<ReferenceRelationStatement
				relationKind="reference_verifies_claims_of"
				currentTaskIsStatementSubject={false}
				rootTitle="本方"
				counterpartLabel="对方"
			/>,
		),
	);
	expect(container.textContent).toContain("← 主张由其核验（旧关系）");
});
