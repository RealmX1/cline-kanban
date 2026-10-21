import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";
export function buildRvfAutomaticCloseoutPrompt(record: RvfAutomaticCloseoutRecord) {
	return `这是 Kanban 根据已登记的 RVF 开审分界自动投递的收尾指令，来源为运行时自动化。
RVF_AUTOMATIC_CLOSEOUT_TOKEN=${record.receipt.decision_token}
RVF run 已完成，主会话已恢复到开审前，修复与暂存内容仍在当前 worktree。请依次使用 $rvf-land 和 $base-branch-sync，读取以下唯一绑定的 handoff 文件：
${record.handoffPath}
run_id=${record.runId}
handoff_sha256=${record.handoffSha256}
先通过 kanban task rvf-automatic-closeout-status --task-id ${record.taskId} --project-path <当前仓库 main checkout 路径> 核对 token、run 和 handoff。使用 rvf land prepare --handoff <上述路径> --run-dir <绑定 run 目录> --repo .，继续按 skill 完成 sanity-check、验证、提交、封窗，再执行 base-branch-sync。不要开启新 RVF，不要改用 latest run。
继续遵守原始需求中明确的不提交、不回 base 或停止限制；如存在这些限制或实际门禁，停止相应动作并报告具体原因。不要部署，不要自动移动到 Done。完成后如实汇报 land 与 base 同步各自结果。`;
}
