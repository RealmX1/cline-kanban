// 创建前给 Agent 与 AI 名称建议共用的命名约定。
export const SUGGESTED_TASK_CATEGORY_TAG_VOCABULARY: Readonly<Record<string, string>> = {
	FEAT: "change type: a new feature or capability",
	FIX: "change type: fixing a defect, an error, or behavior that differs from what is expected",
	REFACTOR: "change type: restructuring, renaming, or splitting code without changing behavior",
	PERF: "change type: performance, memory, or latency",
	TEST: "change type: tests",
	DOCS: "change type: documentation, context files, or written content",
	BUILD: "change type: build system, packaging, or dependencies",
	CI: "change type: CI configuration and scripts",
	CHORE: "change type: routine maintenance that fits none of the above",
	REVERT: "change type: reverting an earlier change",
	RESEARCH:
		"change type: investigation, root-causing, a question, or evaluating options without a planned code change",
	UI: "area: user interface, interaction, styling, or presentation",
	AGENT: "area: agent harness, agent session, hook, or prompt integration",
};

export const TASK_NAMING_CONVENTIONS_GUIDANCE = [
	"Task 名称表达整个任务的稳定目的与具体结果，推荐格式：[类型,可选领域]具体结果。",
	"用简体中文为主，技术标识符保留原文；正文建议不超过 60 字，总长最多 80 字。",
	"最多三个简短大写 tag，先类型再可选领域；不要把工作过程、当前阶段或工具操作写成 Task 名称。",
	`推荐 tag：${Object.keys(SUGGESTED_TASK_CATEGORY_TAG_VOCABULARY).join(", ")}；必要时允许具体子系统 tag。`,
].join("\n");

export function renderTaskAgentNamingAndWorkPhaseGoalGuidance(): string {
	return `${TASK_NAMING_CONVENTIONS_GUIDANCE}
名称只在核对原始需求与批准范围后确需变化时，用 task rename-current-task --title ... --reason ... 修改；Compaction 或工具操作不意味着改名。
真实阶段变化用 task set-current-work-phase-goal --goal ...（最多160字），结束用 task clear-current-work-phase-goal；不必每步更新。`;
}
