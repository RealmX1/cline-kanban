# Claude 到 Codex 主会话交接实施合同

状态：PLAN-READY，用户已批准实施。任务：70c82。

## 能力与边界

- 默认新建 Codex，也可选择同任务已有 Codex 协作会话，接任 Claude 主会话。
- Task、Kanban session 和原生会话 ID 不变；运行时持久化 `mainTaskConversationSessionId`，旧任务回落到 Task ID。
- hook 只写来源 session；主卡展示、默认会话、任务消息、恢复、通知、移列和自动化跟随当前主会话绑定。
- 原 Claude 保留为前主会话；checkpoint、转录和 RVF 编辑证据不伪造归属。
- 只做 Claude → Codex。状态汇总已另建 Backlog 7ae0f；本次不接入 intention system，不转换跨 harness 原生历史。

## 用户已定交互

- 提供交接材料预览与补充：任务需求/约束、计划引用与批准证据、精确 transcript 引用、最后 agent 正文及来源、当前工作区状态。
- 材料缺失明确列明，允许继续；不唤醒 Claude 请求总结，不用 cwd-latest 猜历史。
- 任一相关会话仍在生成时，弹窗提供「暂不交接」和默认「等待两者都停下后自动交接」。不主动中断。
- 等待跨浏览器关闭、运行时重启保留，可取消；空闲后重采材料，原子复核绑定并切换。
- Codex 通过 Plan 入口只读梳理，汇报「计划总览、已经实现、有待进行」，随后等用户消息。
- 首次汇报及等待用户期间暂停自动 RVF/自动继续/自动收尾；权限档位不变。
- 投递幂等，失败可重试；不得重复创建会话或静默退回 Claude。旧排队消息保持原会话归属。

## 实施切片与验证

1. 主会话绑定与只读派生：旧数据兼容、卡片/会话寻址、来源会话权限判定、旧客户端保存保护。
2. 持久交接协调：预览、等待/取消/重启恢复、并发复核、材料持久化和投递失败恢复。
3. UI 与任务操作接线：Sessions 入口、默认新建、双主机展示、消息与恢复寻址、汇报期间自动化闸。
4. 隔离 HOME + fixture Git + 真实浏览器端到端：新建/已有 Codex、迟到 hook、空闲等待、失败重试、恢复及报告后等待。

先写行为红测再实现；运行相关 guarded 测试、根和 web typecheck、lint 与打包；收尾注册部署后验证，不提交或部署。

## 开工核对

- local main / task HEAD：`2b09cd24a588c66fa374edcc6ca7b2bc11ab2ffc`。
- one-way bootstrap 已完成，base 无新增，锁已释放，receipt 在本任务 absolute git-dir。
- sibling 只读调查完整，342 个任务。活跃共享文件：73a2e（评论后完成）、48069（Validation 后焦点导航）。已读具体 diff，行为与本功能独立且物理 worktree 隔离。
- 用户明确要求不为纯执行顺序提问，且已授权实现完整计划；按该优先指令并行实施，不收窄功能、不修改或吸收 sibling WIP，后续 base 更新时复核。
- 软重叠：06a33（持久交接目录）、8ff17（集成检查）、c269f（harness）、dbfe4（热重启）、e2dfc（非活体消息投递）、f75af（模型配置）。

## 实施结果

实现与部署前验证完成：运行时 427 项、Web 128 项、交接集成 10 项、workspace-state 集成 28 项、打包态浏览器矩阵 2 项通过；根与 Web typecheck、Biome、构建通过。真实模型未调用，部署后验证已登记 1 项自动脚本和 1 项引导观察。

持久验证报告：`/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/task-70c82-implementation-report.md`。包含验证证据、部署后验证 ID/资产/清理命令、后续 local main 漂移复核和共享构建产物修复记录。代码尚未提交、未合并、未部署本功能。

## RVF 与当前基线

RVF run：`rvf-20261018T231614Z-agentic-initiation-start-59c031c5`。进入审查前已单向吸收 local main `5cf5606c9a1f3b5c633a6721a30e3a269b68893e`；唯一 WIP 冲突合并保留 Done 评论检查和主会话寻址，未 handback/push。双评审正式覆盖 55/55 路径，5 项报告经验证 4 项成立、1 项默认入口语义误报，合并为 3 个修复组并由独立 attempt 修复合回。

修复包括：切主前双方启动快照同事务保存、接任 main 的答案冷恢复与显式前主配置恢复；Last turn 跟随当前主 checkpoint；真人消息只有真实提交确认后解除自动化暂停，失败与待确认保留，原生 hook 和异步回执幂等。最终验证与逐项证据以本轮 RVF handoff 为准。部署后验证仍为原 2 个 ID（1 自动 + 1 引导），已 reconcile，真实模型尚待部署后观察。
