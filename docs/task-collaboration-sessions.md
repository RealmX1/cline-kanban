# 同任务的协作会话

Sessions 的 Create session 提供「协作会话」与 By the way。协作会话使用与「创建任务」相同的可启动 agent 目录和安装状态；可以选不同于主会话的 agent，也可以再开一条相同 agent 的会话。

## 角色与归属

| 角色 | 上下文 | 文件与命令 | 卡片生命周期 |
| --- | --- | --- | --- |
| `main`（旧记录可以省略 metadata） | 既有主会话规则 | 遵循卡片权限 | 主责任入口 |
| `by_the_way` | 保留既有 fresh / fork 限制 | 保留只读限制 | 不自动转审或收尾 |
| `task_collaborator` | 全新上下文，或同 Agent 时复刻当前主会话；用户填写首条消息 | 共用宿主工作目录，遵循创建时权限快照 | 不自动转审或收尾 |

`workspaceTaskId` 标识宿主卡片与工作目录；`taskId` 标识当前会话。协作会话拥有独立的 `task-conversation-session-<uuid>`，不创建第二张卡片。`KANBAN_TASK_ID` 仍指宿主，`KANBAN_TASK_CONVERSATION_SESSION_ID` 指当前会话。原生会话身份、hook 与转录以当前会话寻址。

写权限与生命周期权限分开判断：只读仍由 By the way 角色决定；非主会话统一经 `isTaskConversationSessionWithoutTaskLifecycleAuthority` 排除主卡 checkpoint、转审通知和自动收尾入口。协作提示明确责任边界；它不建立文件写入隔离，也不建立新的 CLI 权限系统。

## 启动与恢复

创建时将有效权限、Plan 起步设置、实际 transport 与会话专属模型配置保存在 metadata 的 `taskConversationSessionLaunchSettings` 中。从全新上下文创建时使用所选 Agent 的默认模型。Claude、Codex、OMP 在选择相同 Agent 且主会话已有可靠原生 ID 时默认复刻当前主会话，也可手动选择全新上下文；已有协作会话或 By the way 不阻止再次创建协作 fork。不同 Agent、身份未就绪或不支持 fork 时禁用复刻并显示原因。

协作 fork 按当前主责任绑定及精确原生 ID 寻址，不使用 cwd-latest；提交期间主绑定或原生身份变化时拒绝陈旧请求。模型跟随源原生会话当前持久化状态，不用卡片旧模型或新会话默认模型覆盖；Claude 复用按 ID 的模型探针，Codex/OMP 沿用原生 fork 继承。OMP 默认沿用主会话的 TUI/ACP 通道。

OMP TUI 的 `plan.defaultOnStartup` 只对空白历史生效，ACP `set_mode` 也只改内存。TUI fork 使用 `--fork <source-id>`；需要 Plan 起步时加载会话专属的托管扩展，在原生模式恢复之前为独立子身份追加 `mode_change` 并 `flush`。扩展使用已核对的原生 `SessionManager` 方法；若后续 OMP 的只读上下文不再暴露这些方法，则明确退出，避免静默投递可写首条消息。ACP fork 核对握手能力，再以返回的新 ID 重播历史并设置本次连接的 Plan 状态；重播沿用恢复守卫，不推进本轮产出时间戳。

本能力复刻的是创建时 harness 可读取的已持久化上下文，不提供任意历史 turn 锚定，也不保证包含仍在生成且尚未落盘的内容。By the way 的既有首次 fork 规则保持。

PTY、ACP 和既有 SDK 通路均保留宿主与当前会话两个 ID。启动返回前持久化 summary；恢复按自身原生 ID 与启动快照寻址。续跑不重投首条消息，也不重新执行 Plan 起步。OMP 协作会话切换 transport 时更新自身快照，不改宿主卡片的通道。

首次 PTY fork 进程崩溃后，自动重启只恢复已观测到的独立子会话原生 ID，不再次 fork 主会话。尚未记录可靠子身份时停止自动重启并显示原因，不按共享目录猜测会话，也不重投首条消息。

单独停止或重启协作会话只影响该会话。停止宿主任务时，运行时枚举全部 transport，停止所有归属于该任务的会话。资源统计归属宿主；关系投影明确识别主会话，投影表版本提升到 2。

RVF 的编辑归属仍按各会话记录；共享 worktree 的全部改动不会自动归入主会话。本功能不迁移跨 agent 历史，不聚合平级会话状态，也不实现完整 Task Force。

## Claude 到 Codex 的主会话交接

Sessions 提供「交接给 Codex」。默认创建全新 Codex，也可选择同任务已有且具备可靠原生身份的 Codex 协作会话。仅支持 Claude → Codex；不转换历史，不交换 Task、Kanban session 或原生 ID。原 Claude 显示为「前主会话」。任务内状态汇总由独立 Backlog `7ae0f` 跟进。

`RuntimeBoardCard.mainTaskConversationSessionId` 是当前主责任的持久权威，缺省时回落到卡片 ID。`taskConversationSessionRole` 是按该绑定派生的当前角色；`taskConversationSessionRoleAtCreation` 保留创建角色。任务展示、默认选择、CLI 任务消息、任务启动/恢复、通知、移列与 checkpoint 读取当前绑定。显式选择前主会话仍可操作它；所有 hook 始终更新来源 session，不能以宿主 Task ID 冒充新主会话。旧浏览器整板保存无法覆盖主绑定或丢弃新主会话。

`startTaskSession` 省略 `workspaceTaskId` 时按 Task 默认入口跟随当前主绑定；显式传入时按 session 寻址，前主的 session ID 等于宿主 Task ID 时也同样适用。Sessions 的重启按钮走 `refreshTaskTerminal`，始终按所选 session 的持久归属、原生身份与启动快照恢复，不改变主绑定。双方启动快照与主绑定一起落盘；新 Codex 尚未首次启动时安全地全新启动，已有 peer 接任 main 后仍按自己的快照冷恢复和接收已保存答案。

交接材料契约在 `src/core/task-main-session-handover-contract.ts`，当前 Claude 采集器在 `src/agent-session-history/claude-main-session-handover-material.ts`。材料包括原需求与约束、当前阶段目标、计划路径与批准证据、精确 transcript 引用、最后可确认的 agent 正文及来源、工作区 git 状态和用户补充。只按已确认的原生身份寻址，不用 cwd-latest；只有成功 ExitPlanMode 回执与当前计划正文逐字匹配时才标记已批准，其余保持未确认。缺失明确列出，允许继续。

材料正文独立于交接控制记录，持久保存在运行时 HOME 的 `cross-task-handoff-artifacts/<workspaceId>/task-<taskId>-main-session-handover/<handoverId>/`，包含 `HANDOVER.md`、结构化材料与计划/transcript 快照。未来 intention system 可向同一材料范式提供需求、计划与来源证据；当前不依赖该系统，也不把旧计划批准视为本次继续实施的授权。

原 Claude 或所选 Codex 正在生成时，提供「暂不交接」与默认「等待两者都停下后自动交接」。等待记录跨浏览器关闭及运行时重启保留，可取消；协调器在空闲后重采材料、复核双方状态与绑定，再切换责任。不会主动中断正在生成的会话。

新主会话使用自己的启动设置、权限和原生身份；已有 peer 接任时按精确 Codex ID 续跑。首条交接请求通过 `/plan` 要求只读汇报「计划总览、已经实现、有待进行」，随后等用户。交接期间及等用户期间暂停自动继续、排队投递、自动 RVF/收尾入口；真人消息解除等待。Plan 与权限轴正交，不把 Plan 起步翻译成降权。

请求 ID、预留目标 ID 和投递账本保证幂等。确定尚未投递的失败可重试并复用目标 session；跨重启后回执不确定时停止自动重放，用户检查 Codex 后可直接发消息接续。绑定已切换后的失败不会静默退回 Claude。旧队列保留原 session；新任务消息在入队时固定当前 main，回执仍按调用方的 Task ID 记账。

## 自动化验证

定向运行时测试覆盖角色契约、完整终端 agent 候选、ACP 启动归属和冷恢复、独立权限、混合通道停止、OMP 通道切换、通知与关系归属。前端测试覆盖候选来源、未安装禁用、创建失败保留输入和 By the way 回归。

`test/integration/task-collaboration-sessions-real-browser.integration.test.ts` 使用隔离 HOME、fixture Git 仓库、随机端口、真实浏览器与真实 PTY。测试替身只模拟 agent CLI，不请求模型；矩阵覆盖 Claude → Codex、Codex → Claude，以及 Claude、Codex、OMP 的同 Agent fork（OMP 含 TUI/ACP），验证上下文与模型继承、共享目录写入、独立刷新、浏览器重载、运行时重启与整任务停止。默认跳过，设置 `KANBAN_COLLABORATION_SESSION_PACKAGED_CLI_PATH` 后经 `npm run test:guarded -- --project runtime-integration <测试文件>` 执行；可用 `KANBAN_COLLABORATION_SESSION_BROWSER_EVIDENCE_DIRECTORY` 指定持久证据目录。

真实 agent 的配置与原生身份采集由部署后自然使用验证补充。该验证只读观察现有会话，不启动模型或创建生产测试任务；尚未产生跨 agent 协作会话时如实返回未通过。

`test/integration/task-main-session-handover-coordinator.integration.test.ts` 覆盖持久等待、取消、重启恢复、已有 peer、并发互斥、材料缺失、启动重试与不确定回执。`test/integration/task-main-session-handover-real-browser.integration.test.ts` 验证打包态真实浏览器和 PTY 的新建/已有 Codex 接任、迟到 Claude hook 隔离及精确冷恢复。后者需设置 `KANBAN_MAIN_SESSION_HANDOVER_PACKAGED_CLI_PATH`，可用 `KANBAN_MAIN_SESSION_HANDOVER_BROWSER_EVIDENCE_DIRECTORY` 保存持久截图；隔离 HOME 下可通过 `PLAYWRIGHT_BROWSERS_PATH` 指定已安装的浏览器缓存。构建前须检查 `dist` 和 `web-ui/dist` 是否为共享符号链接；本任务测试使用独立构建目录。
