# Kanban Agent 按需操作参考

使用启动提示给出的命令前缀；参数以当前 CLI 的 `--help` 为准。命令返回 JSON，不能把受理、送达、执行完成混为一谈。

- 查询：`task list --project-path <主仓库> [--column <列>]`；已知 ID 用 `task get --task-id <id> --project-path <主仓库>`。跨项目可按 ID 查询，标题不作身份。
- 创建：`task create --title "[FIX,UI]具体结果" --prompt "完整需求" --project-path <主仓库> [--preview]`。先读本目录的 `task-authoring-and-startup-settings.md`。preview 不创建任务；实际 resolvedSettings 给出 base ref、Agent、权限、worktree 与 Plan 默认及来源。仅在确需覆盖时传设置；可用 `--expect-resolved-settings-fingerprint` 绑定预览。
- 编辑/启动：`task update --task-id <id> ...`、`task start --task-id <id>`。名称表达稳定目标；`task rename-current-task --title "新名称" --reason "范围依据"` 仅在核对原始需求后使用。
- 阶段：`task set-current-work-phase-goal --goal "具体阶段结果"` / `task clear-current-work-phase-goal`。Compaction 不意味着改名或新阶段。
- 关闭与删除：`task done` 会影响会话和工作树，`task delete` 永久删除；按用户授权和 `--help` 的 ID/列互斥参数执行。独立 PDV 的 Done 门禁继续有效。
- 消息：`task message`、`task message-status`、`task message-cancel` 使用同一 task-scoped idempotency key。独立回合、后台等待、输入框保护与重启恢复由通用投递机制维护；原生接受与最终执行结果分别报告。
- 同任务侧会话：`task conversation-session create/list/get/report --help`。主会话与可写 peer 可按需创建只读 By the way 或可写 task_collaborator；先查已有会话，使用稳定幂等键，默认复刻创建者，也可 current_main/fresh，跨 Agent 用 fresh。创建后继续工作，是否回报自定；report 默认给创建者，`--target-session` 只接受同 Task Agent 会话。定向追问沿用 `task message --attempt-id`。By the way 只在回答末尾声明 kanban-session-report，不调用写工具。
- 等待：`task park` / `task is-parked` / `task unpark` 支持通用后台作业。人工 rewind、checkpoint、原生 fork 与会话恢复继续保留；Kanban 不自动建立 RVF 分界、rewind 或再投递 Land。
- 旧历史：`task rvf-history` / `runtime.getTaskRvfHistory` 仅从持久工件读取，不启动 Agent 或生产方。旧完成、拒绝、失败与投递事实独立展示；缺证和当前候选覆盖保持 unknown。结果不是提交、同步或部署授权。
- 关系：`work-unit assert-reference-relation --help` 查询关系种类，以当前任务为主体记录一次；`work-unit get-relation-neighborhood-summary` 查询来源。
- 可视化：`task visualization publish --task-id <id> --project-path <主仓库> --source-html-file <持久HTML> --title "标题"`。资源逐项用 `--resource-mapping <相对路径=本机路径>`，可用 `--source-root-directory`。只有 status=published 才称发布成功；awaiting_runtime_acceptance 等待运行时接受。预览用 request-preview，不用宿主机 open。

GitHub 工作优先 `gh issue view <number> --json title,body,comments,labels,state` 等原生命令；Linear 使用当前 Agent 的 MCP，在确需时配置并授权。两者均不隐含对外写入许可。

工作树中的任务命令必须指向主仓库。POSIX 可通过 `dirname "$(git rev-parse --git-common-dir)"` 得到；其他 shell 分步读取。当前任务 ID 以启动身份为准，不能从派生工作树目录重推。

交接文件落在 `KANBAN_TASK_CROSS_TASK_HANDOFF_ARTIFACT_DIRECTORY` 或已提交文件，不能使用机器重启会清空的临时目录。
