# 同任务的协作会话

Sessions 的 Create session 提供「协作会话」与 By the way。协作会话使用与「创建任务」相同的可启动 agent 目录和安装状态；可以选不同于主会话的 agent，也可以再开一条相同 agent 的会话。

## 角色与归属

| 角色 | 上下文 | 文件与命令 | 卡片生命周期 |
| --- | --- | --- | --- |
| `main`（旧记录可以省略 metadata） | 既有主会话规则 | 遵循卡片权限 | 主责任入口 |
| `by_the_way` | 保留既有 fresh / fork 限制 | 保留只读限制 | 不自动转审或收尾 |
| `task_collaborator` | 全新上下文，用户填写首条消息 | 共用宿主工作目录，遵循创建时权限快照 | 不自动转审或收尾 |

`workspaceTaskId` 标识宿主卡片与工作目录；`taskId` 标识当前会话。协作会话拥有独立的 `task-conversation-session-<uuid>`，不创建第二张卡片。`KANBAN_TASK_ID` 仍指宿主，`KANBAN_TASK_CONVERSATION_SESSION_ID` 指当前会话。原生会话身份、hook 与转录以当前会话寻址。

写权限与生命周期权限分开判断：只读仍由 By the way 角色决定；非主会话统一经 `isTaskConversationSessionWithoutTaskLifecycleAuthority` 排除主卡 checkpoint、转审通知和自动收尾入口。协作提示明确责任边界；它不建立文件写入隔离，也不建立新的 CLI 权限系统。

## 启动与恢复

创建时将有效权限、Plan 起步设置、实际 transport 与会话专属模型配置保存在 metadata 的 `taskConversationSessionLaunchSettings` 中。初次创建使用所选 agent 的默认模型，不复制主卡片的模型覆盖。

PTY、ACP 和既有 SDK 通路均保留宿主与当前会话两个 ID。启动返回前持久化 summary；恢复按自身原生 ID 与启动快照寻址。续跑不重投首条消息，也不重新执行 Plan 起步。OMP 协作会话切换 transport 时更新自身快照，不改宿主卡片的通道。

单独停止或重启协作会话只影响该会话。停止宿主任务时，运行时枚举全部 transport，停止所有归属于该任务的会话。资源统计归属宿主；关系投影明确识别主会话，投影表版本提升到 2。

RVF 的编辑归属仍按各会话记录；共享 worktree 的全部改动不会自动归入主会话。本功能不迁移跨 agent 历史，不聚合平级会话状态，也不实现完整 Task Force。

## 自动化验证

定向运行时测试覆盖角色契约、完整终端 agent 候选、ACP 启动归属和冷恢复、独立权限、混合通道停止、OMP 通道切换、通知与关系归属。前端测试覆盖候选来源、未安装禁用、创建失败保留输入和 By the way 回归。

`test/integration/task-collaboration-sessions-real-browser.integration.test.ts` 使用隔离 HOME、fixture Git 仓库、随机端口、真实浏览器与真实 PTY。测试替身只模拟 agent CLI，不请求模型；矩阵覆盖 Claude → Codex、Codex → Claude、Claude → Claude，验证共享目录写入、独立刷新、浏览器重载、运行时重启与整任务停止。默认跳过，设置 `KANBAN_COLLABORATION_SESSION_PACKAGED_CLI_PATH` 后经 `npm run test:guarded -- --project runtime-integration <测试文件>` 执行；可用 `KANBAN_COLLABORATION_SESSION_BROWSER_EVIDENCE_DIRECTORY` 指定持久证据目录。

真实 agent 的配置与原生身份采集由部署后自然使用验证补充。该验证只读观察现有会话，不启动模型或创建生产测试任务；尚未产生跨 agent 协作会话时如实返回未通过。
