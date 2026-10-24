import type { RvfAutomaticCloseoutRecord } from "../core/rvf-automatic-closeout-contract";
export function buildRvfAutomaticCloseoutPrompt(record: RvfAutomaticCloseoutRecord) {
	return `这是 Kanban 根据已登记的 RVF 开审分界自动投递的收尾指令，来源为运行时自动化。
RVF_AUTOMATIC_CLOSEOUT_TOKEN=${record.receipt.decision_token}
RVF run 已完成，主会话已恢复到开审前，修复与暂存内容仍在当前 worktree。先使用 $rvf-land 完成收尾，默认继续使用 $base-branch-sync。读取以下唯一绑定的 handoff 文件：
${record.handoffPath}
run_id=${record.runId}
handoff_sha256=${record.handoffSha256}
先通过 kanban task rvf-automatic-closeout-status --task-id ${record.taskId} --project-path <当前仓库 main checkout 路径> 核对 token、run 和 handoff。使用 rvf land prepare --handoff <上述路径> --run-dir <绑定 run 目录> --repo .，继续按 skill 完成 sanity-check、验证、提交、封窗，再执行 base-branch-sync。不要开启新 RVF，不要改用 latest run。
每个阶段结束后立即登记真实结果：先报告 land，再执行并报告 base_branch_sync。把完整 JSON 写入本 run 的 artifacts/automatic-closeout-<阶段>-execution-result.json，再调用 kanban task report-rvf-automatic-closeout-execution-result --project-path <当前仓库 main checkout 路径> --result-file <该文件>。字段绑定为 ${JSON.stringify({ taskId: record.taskId, decisionToken: record.receipt.decision_token, runId: record.runId, handoffSha256: record.handoffSha256 })}，另加 stage（land 或 base_branch_sync）、outcome（completed、blocked 或 failed）。成功须加实际 commitSha，base 同步还须加实际本地 baseRef；受阻或失败必须填写 reason。不能以指令已提交、报告已写或 Agent 自述代替提交与整合成功；服务端会复核 land evidence、提交存在及祖先关系。
land 完成后评估当前候选是否适合整合到本地 base；任务仅部分完成本身不是暂缓理由，已自洽并通过当前范围验证的阶段成果通常应继续同步。若存在具体的未闭合依赖或会破坏本地 base 的实际风险，可以自主暂缓 base-branch-sync，无需新增许可；立即报告 stage=base_branch_sync、outcome=blocked、blockedReasonKind=agent_assessed_not_ready_for_base_sync、具体 reason 和 baseBranchSyncReassessmentCondition。保留已成功的 land 结果，暂缓不代表同步成功；同一轮不反复催办，条件满足并重新评估后再继续。
继续遵守原始需求中明确的不提交、不回 base 或停止限制；如存在这些限制或实际门禁，停止相应动作并报告具体原因。不要部署，不要自动移动到 Done。完成后如实汇报 land 与 base 同步各自结果。`;
}
