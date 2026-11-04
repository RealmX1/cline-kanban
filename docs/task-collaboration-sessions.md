# 同任务的协作会话

Sessions 的 Create session 提供「协作会话」与 By the way。协作会话使用与「创建任务」相同的可启动 agent 目录和安装状态；可以选不同于主会话的 agent，也可以再开一条相同 agent 的会话。

## 工作分流的定位

Subagent 用于当前会话内部的执行分工，由当前会话调度并整合结果。Peer Session 是同一 Task 内与主线紧密相关且互补的独立协作线，适合需要用户单独查看、持续讨论和调整方向，并能受益于共享当前 workspace/worktree 的工作。只读旁支讨论可使用 By the way，需要参与实现则使用可写 `task_collaborator`。

新 Task 用于需要独立安排、跟踪和验收的工作，包括主线完成后的接续事项和关联较弱的新发现；也可并行开展。等待前置成果时记录依赖和接续条件，创建任务本身不建立自动接续编排。Peer 仍服务于同一 Task 的目标和授权范围，主会话继续负责卡片生命周期。

以上是选择时的参考建议。请在已有授权和权限边界内，结合实际目标、可用能力及协作成本自行判断。完整例子见 [Agent 工作分流参考](agent-guidance/kanban-command-reference.md#工作分流参考)。主会话和可写 Peer 的共享启动指导提供简短定位，创建入口的 CLI 帮助补充各自场景与约束；原生 Subagent 工具继续由对应 harness 提供。

## 角色与归属

| 角色 | 上下文 | 文件与命令 | 卡片生命周期 |
| --- | --- | --- | --- |
| `main`（旧记录可以省略 metadata） | 既有主会话规则 | 遵循卡片权限 | 主责任入口 |
| `by_the_way` | 全新上下文或复刻同 Agent 的来源会话 | 保留只读限制 | 不自动转审或收尾 |
| `task_collaborator` | 全新上下文，或同 Agent 时复刻创建者/当前主会话；首条消息可选 | 共用宿主工作目录，遵循创建时权限快照 | 不自动转审或收尾 |

`workspaceTaskId` 标识宿主卡片与工作目录；`taskId` 标识当前会话。协作会话拥有独立的 `task-conversation-session-<uuid>`，不创建第二张卡片。`KANBAN_TASK_ID` 仍指宿主，`KANBAN_TASK_CONVERSATION_SESSION_ID` 指当前会话。原生会话身份、hook 与转录以当前会话寻址。

写权限与生命周期权限分开判断：只读仍由 By the way 角色决定；非主会话统一经 `isTaskConversationSessionWithoutTaskLifecycleAuthority` 排除主卡 checkpoint、转审通知和自动收尾入口。协作提示明确责任边界；它不建立文件写入隔离，也不建立新的 CLI 权限系统。

## 启动与恢复

By the way 与协作会话的「首条消息（可选）」在全新上下文和 fork 下均可留空。空白统一传为 `""`，不新增 procedure。留空只创建并启动会话，等待输入；fork 可先查看已加载的历史、按需使用原生 Rewind，再发送第一条消息。创建不会自动 Rewind；填写消息时继续沿用现有自动发送行为。

没有消息时，`latestUserMessagePreview` 为 `null`，Sessions 显示「尚未发送消息」和 `Ready`，标题回落为「协作会话」或「By the way」。首次真实输入被接受后按用户原文更新预览；已有接受或回答证据但正文暂不可读时显示「已发送消息」，不再声称尚未发送。每行保留 Session ID，方便区分多条空会话。创建中、图片处理中、Agent 可用性及执行权限门禁继续生效；失败后保留消息、Agent 与上下文选择，成功后选择新会话。

PTY 的空启动不进入响应回合，启动横幅和历史重播不产生新回答、未读回答或回答时间戳；图片附件仍算真实输入。Plan 与权限设置保持独立：Codex 的纯 `/plan` 经就绪、空输入框及分离提交守卫初始化模式，不登记成用户消息，也不进入消息接受确认链；`/plan 正文` 保持原投递路径。排队等待的首条真实消息在模式初始化后继续投递。Kiro 的空启动把 Plan 指导放入托管配置，不再合成规划提问。ACP 的空启动只建立或 fork、加载会话，不发送空 `session/prompt`；每次连接的首个真实请求携带宿主及协作责任指导，展示和幂等仍使用用户原文。

创建时将有效权限、Plan 起步设置、实际 transport 与会话专属模型配置保存在 metadata 的 `taskConversationSessionLaunchSettings` 中。从全新上下文创建时使用所选 Agent 的默认模型。Claude、Codex、OMP 在选择相同 Agent 且主会话已有可靠原生 ID 时默认复刻当前主会话，也可手动选择全新上下文；已有协作会话或 By the way 不阻止再次创建协作 fork。不同 Agent、身份未就绪或不支持 fork 时禁用复刻并显示原因。

协作 fork 按当前主责任绑定及精确原生 ID 寻址，不使用 cwd-latest；提交期间主绑定或原生身份变化时拒绝陈旧请求。模型跟随源原生会话当前持久化状态，不用卡片旧模型或新会话默认模型覆盖；按子身份冷恢复时继续沿用自身模型，显式模型覆盖仍优先；Claude 复用按 ID 的模型探针，Codex/OMP 沿用原生 fork 继承。OMP 默认沿用主会话的 TUI/ACP 通道。

OMP TUI 的 `plan.defaultOnStartup` 只对空白历史生效，ACP `set_mode` 也只改内存。TUI fork 使用 `--fork <source-id>`；需要 Plan 起步时加载会话专属的托管扩展，在原生模式恢复之前为独立子身份追加 `mode_change` 并 `flush`。扩展使用已核对的原生 `SessionManager` 方法；若后续 OMP 的只读上下文不再暴露这些方法，则明确退出，避免静默投递可写首条消息。ACP fork 核对握手能力，再以返回的新 ID 重播历史并设置本次连接的 Plan 状态；重播沿用恢复守卫，不推进本轮产出时间戳。

本能力复刻的是创建时 harness 可读取的已持久化上下文，不提供任意历史 turn 锚定，也不保证包含仍在生成且尚未落盘的内容。By the way 可多次复刻；人工与 Agent 入口使用相同服务和身份门禁，不再限制仅首次 fork。

PTY、ACP 和既有 SDK 通路均保留宿主与当前会话两个 ID。启动返回前持久化 summary；恢复按自身原生 ID 与启动快照寻址。续跑不重投首条消息，也不重新执行 Plan 起步。OMP 协作会话切换 transport 时更新自身快照，不改宿主卡片的通道。

首次 PTY fork 进程崩溃后，自动重启只恢复已观测到的独立子会话原生 ID，不再次 fork 主会话。带首条消息且尚未记录可靠子身份时，维持原有的拒绝自动重启和说明；无首条消息的侧会话按下述补证流程等待，不按共享目录猜测会话，也不重投首条消息。

无首条消息的侧会话在首次输入前就采集启动 hook、托管扩展或 ACP 返回的独立身份。支持按 ID 恢复的 PTY Agent 缺少身份时，`taskConversationSessionNativeIdentityRecovery` 只挂起依赖身份的恢复操作；Codex 还可从本代独享控制端点，只读核对目录和唯一的非父会话候选。不会用共享目录的 latest，也不要求发送占位消息。相同证据最多补查三次、间隔 15 秒，预算跨运行时重启保存；可信 hook、控制端点或绑定证据变化后自动重验。

待接续请求保存在运行时 HOME 的 `side-session-native-identity-recovery/` 私有目录，只保存恢复所需的启动快照，不重放初始正文、图片、首次 fork 或 Plan 起步。身份确认后按子会话 ID 恢复，沿用模型、权限和上下文快照；Rewind 上报的新身份继续替换旧身份。用户 Stop 或开始真实输入会取消此前待接续的执行意图，迟到身份只补证，不重新启动。既有历史会话的恢复规则不作批量迁移。

ACP 冷恢复后的活体摘要同时覆盖整板首帧和增量推流，避免终端管理器水合的旧中断状态触发误移列。

单独停止或重启协作会话只影响该会话。停止宿主任务时，运行时枚举全部 transport，停止所有归属于该任务的会话。资源统计归属宿主；关系投影明确识别主会话，投影表版本提升到 2。

编辑归属仍按各会话记录；共享 worktree 的全部改动不会自动归入主会话。本功能不迁移跨 agent 历史，不聚合平级会话状态，也不实现完整 Task Force。

## Agent 按需分流与可选回报

当前主 Agent 和可写 peer 按工作分流参考自行判断是否创建只读 By the way 或可写 peer。先 `task conversation-session list/get` 核对已有会话，优先复用；需要时 `create`，创建后继续工作。系统不自动等待、催收或将普通回答回灌主线。

```sh
kanban task conversation-session create --task-id <Task ID> --role task_collaborator --reason '独立核对恢复边界' --message '检查既有实现并按需回报' --idempotency-key <稳定请求键> --project-path <主仓库>
kanban task conversation-session list --task-id <Task ID> --project-path <主仓库>
kanban task conversation-session get --task-id <Task ID> --session-id <会话 ID> --project-path <主仓库>
kanban task conversation-session report --task-id <Task ID> --message '检查结论' --idempotency-key <稳定回报键> --project-path <主仓库>
```

`create` 默认使用调用者的 Agent，并以 `--context-source creator` 复刻创建者；`current_main` 选择受理时当前主会话，`fresh` 使用全新上下文。跨 Agent 使用 `fresh`；不支持的复刻明确返回原因。历史只覆盖创建时已持久化的内容，之后各自独立发展。继承历史只作背景，角色标签、历史批准和旧任务指令都不是本次新增授权。`--message-file` 可传持久 UTF-8 正文；首条消息可留空。Agent 创建保留用户正在看的会话，Sessions 后台显示新增项；人工创建仍按明确操作选择新会话。

`get` 返回创建进度、摘要、回报接受状态和分页历史；用 `nextCursor` 作为下一次 `--cursor`。追问复用 `task message --attempt-id <会话 ID>`。可写 peer 的 `report` 默认给创建者，`--target-session current_main` 固定受理时当前主会话，也可填同 Task 的任意 Agent 会话 ID；跨 Task 被拒绝。报告正文会标识来源及程序化性质，不解除等待真人的问答、权限、计划或交接门禁。

By the way 保留只读工具限制，不能调用写 CLI。确需回报时，在新回答末尾、空行后追加独立结构块（真实声明不能包在代码块或引用里）：

```text
<kanban-session-report>
{"text":"需要回报的结论","targetTaskConversationSessionId":"current_main"}
</kanban-session-report>
```

运行时只扫描绑定子身份新产生的 assistant 正文，排除创建边界之前的继承历史、工具消息与代码/引用示例。原生消息 ID 用于去重，旧格式以可信原生记录指纹补充；不采用会随转录重写变化的页内字节位置。扫描进度跨重启保留；没有声明就不发送。回报经持久队列等待接收资格，真实接受与受理分开记录。系统回收目标只按自己的精确原生身份和启动快照恢复，不再次 fork；缺身份等待补证。Stop、Done、搁置与交接等待继续禁止执行，显式 Stop 会取消尚未送达的相关回报。

创建请求在启动前持久预留 ID、启动快照及原生来源身份。同一 Task 代次内相同幂等键返回原请求，不同正文/配置冲突。未知启动不再次创建或重投首条消息；绑定摘要、原生身份及独享控制端点是补证来源。同证据至多三次、至少间隔 15 秒，预算跨重启保存；证据变化后自动重验，其他会话继续工作。尚未尝试投递的持久回报可跨重启接管；已交给 transport 的未知结果沿既有原生接受补证链，保留原失败历史。

新 metadata 分开保存 `creatorTaskConversationSessionId`、`contextSourceTaskConversationSessionId`、`contextSourceNativeSessionIdentity` 与 `defaultReportTargetTaskConversationSessionId`。旧 `sideSessionOriginMain*` 字段仅兼容读取。Sessions、独立建卡按实际来源读取；图谱暂时不能表达 peer 的多级来源轮号时保留未知，不把 peer 轮号当成主会话轮号。

peer 共用工作目录，没有写入隔离；创建者负责明确共享文件与任务范围，不能把其他会话的改动自动算作自己的成果。本期不提供跨 Task 通信或 Task Force 编排。

## 跨 harness 主会话交接

Sessions 提供「交接主会话」，支持 Claude、Codex、Cursor、Droid、Kiro、Kimi、OMP 之间创建新接任会话。目标选择显示安装状态；Cline 与禁用的 harness 不参与。原主保留为可继续对话的辅线，不交换身份。默认全新上下文＋材料；同任务已有 Claude、Codex、Cursor、Kimi、OMP 可写 peer（包括前主会话）也可接任；当前主会话、By the way、shell 与其他任务不参与。

新建目标有两种上下文方式：默认「全新上下文＋交接材料」，用于重新聚焦；「完整复刻原对话」仅在 Claude/Codex/OMP 同 harness 且可靠原生身份就绪时开放，保留已有 compaction 和偏题内容；跨 harness 只交接材料。OMP fork 保留原 PTY/ACP 通道。旧请求未声明方式时仍为全新上下文。既有 peer 接任始终沿用自身历史、模型、权限与 transport，选择后隐藏新建与 fork 的上下文选项；完整复刻缺少可靠身份时显示原因，不静默降级。

`RuntimeBoardCard.mainTaskConversationSessionId` 是当前主责任的持久权威，缺省回落到卡片 ID。当前角色由绑定派生，创建角色不变；`taskConversationSessionHasHeldMainResponsibility` 持久记录接任历史，因此 A → B → C 后 A、B 都显示「前主会话」。默认消息、生命周期、通知、移列和 checkpoint 跟随当前主绑定；显式选择前主仍可操作它。迟到 hook 只更新自己的 session，旧整板保存不能夺回主责任。Done 工作台保留只读门禁。

双方的原生身份、存储归属及独立启动设置与主绑定一起保存。`startTaskSession` 省略 `workspaceTaskId` 时按 Task 默认入口跟随当前主绑定；显式传入时按 session 寻址。已有 peer 和已准备的 fork 按精确原生 ID 冷恢复，不使用 cwd-latest，也不通过「fork 当前主会话」再次分支。全新目标尚未建立原生对话时安全地全新启动；fork 保留原生模型，不被卡片旧 override 覆盖。

全新目标在首条输入前可能尚无原生 ID。运行时先持久固定目标 Agent、进程代际、工作目录及适用的存储归属；可信原生 hook 带回同代际身份后固定只读接受查询的目标。迟到的旧代际 hook 不得覆盖绑定。Droid/Kiro 没有可靠原生 ID 读取器时，必须同时具备完整正文输入 hook 和同代际后续处理 hook；前置输入、Enter 或活进程均不证明接受。新输入会使旧候选失效，避免跨回合串证。

材料契约在 `src/core/task-main-session-handover-contract.ts`。Claude 采集器保留 ExitPlanMode 成功回执与计划逐字匹配的批准判据。通用采集器复用各 harness 可信历史分页、分段祖先及消息去重，保留内嵌 `<proposed_plan>`、明确计划路径、最后连续非工具正文、需求、阶段目标、git 状态和用户补充；普通历史文本不推断为批准。读取、fork 和补证均跟随 `codexConversationStorageHomeDirectoryPath` 及迁移记录，不能按默认目录猜选。

`task-main-session-handover-material-provider.ts` 提供可替换的 `readUserIntentContext` 端口，返回值绑定 workspace、task incarnation、会话身份、asOf、来源与缺口。默认只组装原始材料；提供方缺失、失败或两秒预算耗尽时明确标注不完整并继续，不增加 LLM 采集。My AI Setup/ac08e 的工作单元意图卷宗尚未发布 CLI＋JSON，本实现预留接入，不调用交互式约束提炼，也不把 L1 Recap 冒充完整意图。

Cursor 使用绑定原生 ID 及工作目录对应的 JSONL 导出，先核对 chat 归属，不打开原始 SQLite；Kimi 复用已核验的 session index、state 与主 agent wire 协议头。缺少导出时保持未知，导出出现或改变后自动补查；Cursor 等待真人的读取也跨重启恢复，机器报告不能自行解除等待。

新建请求为 `new_agent_session`＋`agentId`，既有目标为 `existing_agent_session`＋真实 `agentId`＋`taskConversationSessionId`；`new_codex_session`、`existing_codex_session`、旧记录和旧恢复 API 保持兼容。Claude 通过官方 SDK 固定末消息 fork；OMP 使用原生 `--fork` 冻结副本，并复制、核对原生工具附件。已知子身份先持久化再验证，恢复沿原冻结历史，不夹带失败交接报告。

正文与快照持久保存在运行时 HOME 的 `cross-task-handoff-artifacts/<workspaceId>/task-<taskId>-main-session-handover/<handoverId>/`，包括 `HANDOVER.md`、结构化材料、计划与 transcript 分段快照。原生准备凭据独立保存固定来源、完整回合 ID、每次未知尝试及已知子身份；准备失败后保留原材料，不用新读取结果覆盖固定快照。材料与关键凭据完成持久写入后才推进绑定。

接单时持久固定既有 peer 的归属、原生 ID、工作目录、transport、会话模式与完整独立启动设置，并在材料准备、切主、原生启动与投递前重验。运行时实际持有的空闲活体直接复用，不停止或重启；冷恢复只按该 peer 的原生 ID，并保留自身 exploratory / operational 模式，之前 fork 出的 peer 不再 fork。旧绑定缺少模式快照时沿用 peer 当前记录；旧会话未声明模式时按 operational 兼容，不批量迁移。

来源或目标受阻时，预览通过 `blockingConversationSessions` 返回具体会话及原因：正在生成、明确待答、状态待核验。只展示原主和所选接任者的阻塞，不受未选 peer 影响。操作提供「暂不交接」「等待两者都停下后自动交接」「中断并强制交接」。

请求与控制记录的 `busySessionHandoverStrategy` 为 `wait_until_ready` 或 `interrupt_blocking_sessions`，旧请求与旧记录缺省等待。强制策略先保存双方阻塞会话的精确身份、代际和中断意图，再停止对应 PTY/ACP 会话；只有管理器确认无活体、PID 清空且生命周期已停止后才切主。停止失败或结果未知时保存尝试和失败历史，最多三次补证，退出或端点证据变化后自动接续。关闭浏览器和重启不丢失意图；取消和外部明确 Stop 继续阻止后续动作。既有 peer 始终按冻结原生 ID 与独立启动快照恢复，原历史和文件保留。

停止确认与退出摘要同锁持久化。终端 WebSocket 的陈旧会话恢复及冷水合仍归零活性，但交接暂停期间保留冻结的目录和启动代际；没有活体不能单独证明原进程已退出。缺退出事件时仅原 PID 确认不存在才补记退出，PID 仍存在或不可读继续保留未知，存在性变化会重新唤醒有界补证。原进程仍在独立 PTY host 中时接回同一代际，不重复启动。

完整复刻先固定完成回合、创建独立子身份并持久保存，再校验完整历史与工作目录，最后原子切主。准备过程不启动模型；已知子身份只复验，不重复创建。Codex 返回配置 writer 的历史桥接路径时，复用存储层的绑定清单、目录身份与桥接核验后比较真实历史归属，不能直接比较路径文字，也不能接受任意软链。来源身份或固定边界变化则停止陈旧交接。强制中断后缺少完成边界时保留原上下文选择，明确要求用户改选「全新上下文＋交接材料」，不静默截断历史。

首条汇报在 Codex 使用 TUI 原生 `/plan` 命令，其余目标使用各自 Plan 起步设置；共用长粘贴处理，要求只读汇报「计划总览、已经实现、有待进行」，随后等待真人消息。交接及等待期间暂停自动继续与排队投递；只有真人输入的实际接受证明解除 hold。Plan 与权限轴独立。

请求 ID、预留目标、投递 attempt 和账本保证幂等。报告提交前固定原生身份、目录和存储归属；接受未知时只读查询原生历史，控制端点不可用则读取可信持久记录，并保存分页进度。完整正文必须逐字一致，兼容原生 `/plan` 消费前缀；只有标记或截断正文不算接受。迟到证明独立于原失败账本保留，复核当前主绑定和原生身份后自动转入等用户，不自动重发模型回合。

`automaticRecovery` 区分机器待证据、执行禁止与人类取舍。同一证据最多三次、至少间隔 15 秒，预算跨重启保留；预算耗尽等待历史、迁移绑定、端点或准备凭据变化。准备阶段确认未启动模型时，可从固定边界有界另建尝试，未知旧尝试继续保留，只有一个目标能取得主绑定。用户 Stop、归属不符或主绑定改变停止对应执行；Stop 不被后台恢复撤销。

仍可显式选择「新建目标 Agent 并重新交接」，确认可能重复汇报后走通用恢复 API。旧 Codex 恢复 API 继续兼容 Codex 记录，不能改变非 Codex 目标。恢复凭据保存原控制记录及预留目标，重复确认复用同一目标；完整复刻恢复沿原固定历史边界创建独立子会话，不改成空白上下文。既有 peer 的显式新建恢复会转换为同一 Agent 的 `new_agent_session`，清除旧 peer 绑定，并明确说明改为全新上下文读取材料。绑定切换后的失败不静默回退到前主。

## 从侧会话分出独立任务

Sessions 的 By the way 与协作会话行提供「分出独立任务」。来源会话继续保留，同一来源可以分出多张卡；前主会话不提供此入口。新卡与来源会话双向链接，关系账本从建卡事件投影 `provenance_split_from_side_conversation_of`，不自动建立子任务关系。投影表版本为 4，固定历史种子不作为匿名来源展示。

上下文与工作树是两项独立选择。默认完整继承来源的原生历史，使用独立的原生 ID、工作目录、hook 与任务生命周期；目前 Codex 使用带完整回合边界的 `thread/fork`，Claude 使用 SDK 的无模型 `forkSession` 固定种子，新任务再从种子 fork。不支持可靠原生分支时明确禁用完整继承，仍可选全新上下文，只提供 Initial Prompt。完整继承保留已有 compaction 和上下文，界面明确提示该取舍。

工作树有三种来源：立即从 local main 新建（默认）；先建 Backlog，等来源任务完成且成果进入 local main 后手动启动，启动时才建树；立即复制来源 Git 工作状态。复制包括 HEAD 与尚未合入的提交、staged、unstaged、非 ignored 的 untracked，保留 index 区分、二进制、重命名、删除、执行位和符号链接。ignored 路径仍使用普通建树规则。快照归档 HEAD 历史与暂存 blob，避免来源清理或 GC 后丢失；不提交、stash、reset 或修改来源工作目录。冲突、子模块或无法安全复制的路径明确拒绝，复制期间发生变化则失败，不使用不完整快照启动。

Backlog 的门禁在服务端，卡片启动、直接 runtime 启动及首次建树都核验。来源需在 Done，工作树及保留补丁没有未落地修改，并通过既有 exact SHA / stable patch-id 共享落地判据；Done、ahead=0 或未观测到自有提交都不能单独证明落地。成功首次授权后持久保存结果，后续恢复不重新依赖来源状态。不新增自动调度或恢复已退役的依赖自动启动。

用户可填写本次分出说明；自动建议同时生成描述建议、标题与必填 Initial Prompt。默认使用 Kanban 模型 API，未绑定用途时选择 DeepSeek 的既有 Flash 浮动模型标识；用途绑定、凭据、用量日志复用现有机制。失败后可显式换 provider、手动填写，或在具备固定种子和启动参数快照的 Claude 来源上选择另开无工具 Agent 分身。分身选项明确提示历史计费成本，不自动回退或重试付费请求。

自动建议使用起点前全部真人输入与最后一轮 Agent 正文，加所选侧会话起点后的全部用户和 Agent 正文，以及本次分出说明；普通工具仅保留原文引用，真人问答答案从工具结果中单独保留。起点前整理接口将来可由 Intention System 替换。缺失材料与 1.5 MB 生成输入上限明确显示，不静默截断。来源回答期间先持久等待，不中断；若已进入后续回合而错过原停止边沿，则要求显式重新固定，不混入后续聊天。

草稿、来源转录快照、原生种子、生成版本及创建记录保存在运行时 HOME 的 `cross-task-handoff-artifacts/independent-task-creation/<workspace-hash>/<requestId>/`，独立于来源 worktree。编辑自动保存，更新草稿与创建才触发描述变更后的模型生成；手改标题和 Initial Prompt 保留，迟到结果不能覆盖新版本。请求 ID 幂等；重启不重放未完成的付费请求或不确定的首次启动，已创建卡保留可恢复入口。

`test/integration/independent-task-creation-real-browser.integration.test.ts` 用隔离 HOME、fixture Git、模拟模型 API、真实 PTY 与桌面/手机浏览器覆盖固定材料、真人答案、手改恢复、三种建树、门禁、多卡与重复创建、运行时重启。设置 `KANBAN_INDEPENDENT_TASK_CREATION_PACKAGED_CLI_PATH`，可用 `KANBAN_INDEPENDENT_TASK_CREATION_BROWSER_EVIDENCE_DIRECTORY` 指定持久证据；浏览器缓存位置经 `PLAYWRIGHT_BROWSERS_PATH` 指定。原生历史分支另有真实 Claude SDK 文件测试与 Codex 协议测试，不调用真实模型。

## 自动化验证

定向运行时测试覆盖角色契约、完整终端 agent 候选、ACP 启动归属和冷恢复、独立权限、混合通道停止、OMP 通道切换、通知与关系归属。前端测试覆盖候选来源、未安装禁用、创建失败保留输入和 By the way 回归。

`test/integration/task-collaboration-sessions-real-browser.integration.test.ts` 使用隔离 HOME、fixture Git 仓库、随机端口、真实浏览器与真实 PTY。测试替身只模拟 agent CLI，不请求模型；矩阵覆盖 Claude → Codex、Codex → Claude，以及 Claude、Codex、OMP 的同 Agent fork（OMP 含 TUI/ACP），验证上下文与模型继承、共享目录写入、独立刷新、浏览器重载、运行时重启与整任务停止。默认跳过，设置 `KANBAN_COLLABORATION_SESSION_PACKAGED_CLI_PATH` 后经 `npm run test:guarded -- --project runtime-integration <测试文件>` 执行；可用 `KANBAN_COLLABORATION_SESSION_BROWSER_EVIDENCE_DIRECTORY` 指定持久证据目录。

真实 agent 的配置与原生身份采集由部署后自然使用验证补充。该验证只读观察现有会话，不启动模型或创建生产测试任务；尚未产生跨 agent 协作会话时如实返回未通过。

`test/integration/task-main-session-handover-coordinator.integration.test.ts` 覆盖持久等待、取消、重启恢复、已有 peer、并发互斥、材料缺失、启动重试与不确定回执。`test/integration/task-main-session-handover-real-browser.integration.test.ts` 验证打包态真实浏览器和 PTY 的新建/已有 Codex 接任、迟到 Claude hook 隔离及精确冷恢复。后者需设置 `KANBAN_MAIN_SESSION_HANDOVER_PACKAGED_CLI_PATH`，可用 `KANBAN_MAIN_SESSION_HANDOVER_BROWSER_EVIDENCE_DIRECTORY` 保存持久截图；隔离 HOME 下可通过 `PLAYWRIGHT_BROWSERS_PATH` 指定已安装的浏览器缓存。构建前须检查 `dist` 和 `web-ui/dist` 是否为共享符号链接；本任务测试使用独立构建目录。


`test/integration/task-main-session-handover-native-codex.integration.test.ts` 使用真实 Codex 和隔离本地模型，验证两种上下文、Plan 首轮、完整原生接受证据、冷恢复及真人继续；设置 `KANBAN_CODEX_NATIVE_SESSION_TEST_BINARY` 与上述打包 CLI 路径启用，可用 `KANBAN_MAIN_SESSION_HANDOVER_NATIVE_EVIDENCE_DIRECTORY` 保存原生分段与结果。不会访问外部模型或用户凭据。
