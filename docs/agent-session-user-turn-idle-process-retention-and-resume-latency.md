# 会话待命回收时间与恢复耗时

## 全局设置

`agentSessionUserTurnIdleProcessRetentionDurationMinutes` 为正整数分钟，旧配置缺省60。设置位于“可靠性 / 会话待命保留时间”，所有项目共享。API、更新函数或完整保存省略字段时保留磁盘已有值。无效值拒绝保存。

普通待命从 `currentAgentProcessUserTurnIdleRetentionStarted` 起算，默认一小时。扫描器每60秒读全局设置，再按持久 `retentionAnchorAt` 更新绝对期限，随后判断到期。缩短和延长都不需要重启；配置不可读或期限写入失败时记录原因并在后续扫描重试，不按未核实期限回收。

启动后的首次扫描沿用持久锚点；runtime 脱离独立 PTY host 前也更新同一账本。交接无法核实时给 host 的孤儿期限为 null，等待 runtime 恢复后补证。运行中回合、存量后台工作及原生执行检查继续保护进程。park 的独立期限和卡片历史活动时间保持各自语义。

## 自动恢复

连续可见200毫秒后发起恢复，快速切卡取消、隐藏标签页门禁、每代尝试闩、失败冷却及服务端每任务互斥保持。摘要刷新不作为打开信号。持久 Stop 在请求入口和启动前重新检查；显式启动仍按原有入口解除对应 Stop。

当前代回收结果确认根进程和后代均退出、没有活进程槽位且不是配置自动采用或显式后台接管时，完整预检仅由共享启动入口执行一次。其余路径保留刷新入口的破坏前预检。Codex 启动只定向读取本次 writer，登记启动参数也只更新本 writer；配置合并、每代私有副本、插件、原生身份和信任门禁照常执行。

## 启动诊断

日志仍在 `~/.cline/kanban/task-session-start-diagnostics/task-session-start-diagnostics.log`：

| phase | 含义 |
| --- | --- |
| `frontend_automatic_resume_visible_dwell` | 浏览器实际经历的可见停留等待，客户端诊断数值不参与资格判断 |
| `server_refresh_request_to_runtime_started` | 刷新请求进入服务端至会话启动入口返回 |
| `server_session_preparation` | 共享启动请求到完成配置和预检准备 |
| `native_input_ready_after_spawn` | 该代进程 spawn 到当前镜像显示原生输入框就绪；缺少结构判据的 agent 不伪造就绪 |

各段边界可能重叠，不能简单相加代替用户耗时。所有服务端记录带 workspace、会话和代次，输入框就绪每代只记录一次。用户体验以浏览器打开到新代原生输入框接受文字的测量为准。

## 隔离测量

任务 `c5bc3` 的持久交接产物 `session-resume-and-idle-retention/archived-native-session-resume-benchmark/` 保存完整实验、来源哈希及 guarded 复跑入口；前后各10次的原始结果与截图保留在同级目录。本实验使用隔离 HOME/CODEX_HOME/CODEX_SQLITE_HOME、真实 Codex 与浏览器、本地模型；确认新代输入框实际接收文字，并核对原生身份与原回合。所有输入探针重试耗时计入“打开到可输入”，p50 为中位数、p95 为最近秩。短历史样本不能保证重型生产会话的耗时。
