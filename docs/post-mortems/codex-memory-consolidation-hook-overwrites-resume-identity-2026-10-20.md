# Codex 后台记忆整理 hook 覆盖续接身份

任务 `e9106`；真实事故任务 `review-validate-fix/e9e12`。同一缺陷此前在 `f5853` 登记为 Backlog，尚未实施。

## 因果与证据

2026-10-20 12:03 UTC，主会话正常 Stop，原生 ID 为 `01a15120-4476-78b0-8c56-5a7321338e0b`，带有效转录路径。随后 Codex memory phase-2 整理作业继承同一进程的 hook 配置与任务环境变量；其工具 hook 没有 `agent_id`，却带另一 `session_id` 和空 `transcript_path`。12:12 UTC，主任务已保存的身份变为 `01a1592f-121b-7d31-9435-768bfffda4e8`。该 ID 不存在于 Codex 会话文件或线程索引。17:48 UTC，重新打开任务按坏 ID 续接，快速退出并触发熔断。

原会话完整历史仍在；stale / focus 只暴露了已污染的地址。只刷新终端、放宽熔断或改用 `--last` 均不能解决归属问题，且 `--last` 可能选到共享 cwd 的其它对话。

本机 Codex 0.163.0 的隔离探针确认：普通会话的首个 SessionStart 已有转录路径；`--ephemeral` 的 SessionStart 返回 null。不要通过禁用用户的 memories 功能规避宿主归属缺陷。

## 防线

- Codex hook 在归档、enrich、传输之前排除无有效转录路径的整个事件；身份抽取也拒绝产出这类身份。只跳过身份写入会留下活动、通知、阶段目标和 checkpoint 污染。
- 服务端在任何主会话写入之前排除旧 CLI / spool 携带的同形身份，返回成功确认，避免无意义重试。
- 已记录的 Codex ID 在续接前必须有可读、元数据 ID 匹配的主会话转录。先核对已记录路径，再只枚举该 ID 的原始 / 恢复分片文件名；不扫描其它会话正文、不按 cwd / 更新时间猜会话，也不把 SQLite 索引行单独当成历史存在的证明。
- 预检位于启动与刷新的销毁动作之前；缺失时零 spawn，不停止现有 PTY，保留原身份并显示具体原因。
- Claude / Cursor 等其它 harness 的无路径身份语义保持原样。

## 恢复与验证

运行实例在线时，通过 `kanban hooks ingest --event agent_conversation_session_identity_observed --source codex` 提交只读核实的正确 ID 与转录路径，再刷新目标终端。不要直接改在线 `sessions.json`，也不要伪造原生历史或用户消息。

预检不会自动修复历史污染。`cline-kanban/d55ee` 的坏 ID `01a15a85-df0c-7ab2-96fa-d9aeb5363b65` 在 2026-10-20 18:24:26 UTC 已保存，部署前备份也保留了同一空路径身份；18:43:53 UTC 部署后，预检拒绝续接该 ID。历史 Stop 档案与原生主转录共同确认其正确 ID 为 `01a15856-45af-7d91-b762-51e3f46d38d7`，该 ID 的恢复分片能通过预检。经正式身份事件恢复并仅刷新 d55ee 后，已核对原生 `resume <正确 ID>` 参数与终端快照；运行时 PID 未变，观察窗口内其它 13 个活跃任务的 PID 未变。不能从单例恢复推定其它历史身份均已修复，也不能只按 cwd 选择候选并自动覆盖。

自动回归包含无 agent_id 的坏样本、旧 CLI / spool 重投、有效首个身份、分片、无效身份零 spawn 与保留旧 PTY。隔离真实 Codex TUI 通过打包 CLI 记录主会话与侧会话身份，投递坏样本后验证主 summary 不变，强杀并重启隔离运行时后再次核对持久身份；目录隔离原生 smoke 另覆盖 resume、隐式 fork 与显式跨目录 fork。

持久现场记录、授权、测试、构建及部署恢复结果在 `~/.cline/kanban/cross-task-handoff-artifacts/task-e9106-codex-native-session-resume-recovery/`。部署、运行时验证及现场恢复必须按各自证据分别报告。

本任务此前直接部署中断了其它活跃任务；这是独立的操作失误。部署请求与人工确认规则的修正由 `bdda6` 负责，本任务不修改其 skill 范围。上述 d55ee 恢复没有重新部署或重启服务。当前候选源码仍未提交、未落入 local main；运行实例包含候选补丁，不等于该补丁已经正式评审或集成。
