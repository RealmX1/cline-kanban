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

export function renderTaskAgentNamingAndWorkPhaseGoalGuidance(commandPrefix: string): string {
	return `# Task 命名与当前阶段目标
${TASK_NAMING_CONVENTIONS_GUIDANCE}
创建 Task 前先遵循上述约定，使用 ${commandPrefix} task create --title "[FIX,UI]修复 Backlog 名称编辑" --prompt "完整需求" --project-path <main repository path>。省略 title 时仅从 prompt 推导兜底，不会额外调用模型。
仅当名称无法反映整个 Task 的稳定目标时，先核对持久保存的初始需求、批准计划与后续范围变化，再用 ${commandPrefix} task rename-current-task --title "新名称" --reason "核对范围后的改名原因"。这两个参数足够，目标由调用环境决定。
Compaction 后若缺乏可验证的完整范围，保持 Task 名称，只更新当前阶段目标；不要因普通工具操作、Stop 或 compaction 自动改名。
真实阶段切换时，用 ${commandPrefix} task set-current-work-phase-goal --goal "这一阶段要达成的具体结果"（最多 160 字）；阶段结束用 ${commandPrefix} task clear-current-work-phase-goal。阶段目标与 Task 名称分开，不必每个工具操作都更新，也不要求另建 To Do List。
`;
}
