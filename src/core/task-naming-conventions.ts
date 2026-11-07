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

export function renderTaskAgentOverviewAndWorkProgressMaintenanceGuidance(): string {
	return `${TASK_NAMING_CONVENTIONS_GUIDANCE}
名称只在核对原始需求与批准范围后确需变化时，用 task rename-current-task --title ... --reason ... 修改；Compaction 或工具操作不意味着改名。
Task Name 与独立 taskDescription 都可以随已批准目标、范围及方案修正更新；Initial Prompt 保留原始来源，不用汇报覆盖。
计划完成、已获准开始实施时，必须先 task get 读取最新概况，再用 task record-current-task-progress --implementation-started --title ... --description ... --expected-task-updated-at <task.updatedAt> --text ... 核对名称并更新简介。
真实阶段变化用 task record-current-task-progress --progress-entry-id <稳定幂等身份> --text ...（最多160字）；有上一条当前进展时同时提供 --previous-entry-id ... --previous-outcome completed|abandoned，必要时附 --outcome-explanation ...。
成功阶段标 completed，放弃或换路径标 abandoned；不能仅因换阶段推断成功。Progress 是实际进展，原生 To-do 是执行计划，不重复维护细粒度清单。
每次更新 Progress 顺带检查名称与简介是否需按已批准变化同步；不必每步更新，不另注入催报回合。旧 task set-current-work-phase-goal / clear-current-work-phase-goal 继续兼容。`;
}
