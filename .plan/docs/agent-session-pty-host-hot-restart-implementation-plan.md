# Kanban 热重启与会话保活：最新实施提案

更新日期：2026-10-29。固定源码基线：local main `4c8163c1223a329a41aed71bd459b99d1cfd742a`。

本文件取代此前 P4–P6 的当前待办描述。历史设计、当时的授权解释和测试记录保存在文末列出的持久材料中；历史测试与 RVF 只证明各自对应的候选。本轮交付为旧 WIP 审计、单向同步、必要兼容整合及更新计划，新增能力仍是提案。

## 当前阶段：用户明确启动 RVF（2026-10-29）

用户在本文件上一阶段交付后明确调用 `review-validate-fix:review-validate-fix`。现在按该技能对现有 P4、同步整合及计划文件的 57 路径执行双审、相关修复、最终验证与主会话普通提交。固定起点使用 P3 提交 `88303a417549463a5eedd7f0ea52a89fb2034c11`，依据旧评审准备记录中的 committed baseline；当前整合态 HEAD 为 `4c8163c1`。这次评审不将下文 N2–N6 后续功能提案变为实施要求，base handback、push 和部署仍按各自真实授权。

评审、修复、验证和提交结果以本阶段精确 run 的持久回执为准；下文“本轮”及测试数字记录上一阶段同步与规划的时点，不代表本次 RVF 已完成。

## 上一阶段目标与授权（同步与规划）

原始最低需求是：local deploy 或热重启 Kanban 时，正在进行的 task/chat session 继续运行，coding agent 的活进程不与 runtime 进程强绑定。验收对象包含原进程、原生会话身份、持续输入输出、hook 与状态归属。

本轮用户先要求：

> 现在 local main 已经 advance 了很多，经过了很多比较大的改动。absorb from local main and consider what's to do next and propose the new up to date plan
>
> 再就是有一个小需求被记在了 Backlog 中，你可以分析并吸纳他的诉求"c258b"

随后补充执行顺序：

> 再就是还想请你确认一下先前的 Dirty 是否完成了rvf，如果没完成的话你请你先分析 local main 的 advancement，并确定我们现在的 dirty 是否还有用，然后吸收 local main 并处理 conflict 或者是去除掉当前 dirty，然后再进行我们前面描述的 propose new up-to-date plan and absorb the minor demand in backlog

据此，本轮已执行审计、保全、吸收 local main 和同步必需的兼容修复；随后更新本计划。未开始新功能实施、RVF、提交、handback、push 或部署。`c258b` 保留在 Backlog，仅登记其需求被本计划引用。

## 已核实的起点

| 项目 | 事实与证据边界 |
| --- | --- |
| 本次吸收 | detached task HEAD 从 `92607e84` 快进至 `4c8163c1`，吸收 254 个本地提交，task unique commit 为 0。 |
| main 与远端 | remote refresh 得到 `LOCAL_BASE_CONTAINS_REMOTE`，当时 `origin/main=e5349b6f`；本轮未推进 local main、未 handback、未 push。 |
| 原 dirty | 56 路径：39 tracked unstaged、17 untracked；逐文件原字节和 SHA256 已持久保全。main 在其中修改过 16 路径，P4 核心尚未被整批替代。 |
| 旧 RVF | `f95b0e1d642e50bf` 只完成 prepare，未 dispatch；handoff 标为 `SUPERSEDED_BEFORE_REVIEW / NOT_DISPATCHED`。后继 `73ea98c78168f898` 已撤回、start attempt 为 0、run anchor 为空。其他后继也未开审。 |
| 覆盖结论 | 这批 P4 dirty 没有完成 RVF。P0–P3 的旧评审不能证明 P4 或本次整合后的候选通过；prepare 的 `status=completed` 不能解释成评审完成。 |
| 同步冲突 | 10 文件、16 处冲突已整合，保留原生投递阶段标记、custody、故障恢复、配置同步及新服务关闭入口；不恢复 main 已删除的 RVF 专属编排。 |
| 当前 WIP | 57 路径，40 tracked unstaged、17 untracked。计算为：原 56 − 主线已覆盖的 ESM 源码修复 1 + 新主线测试夹具适配 2。无 staged 内容。 |
| 本轮验证 | Node 24.12.0：28 文件 / 329 项 guarded 单元、6 文件 / 17 项 guarded 隔离集成、60 项前端终端测试通过；根和 web 类型检查通过。集成含 handover、SIGTERM、SIGKILL 后同一替身进程的输入输出连续性。 |
| 尚未重验 | 本轮未重跑隔离构建、打包态 Codex 接管、真实 Claude/Codex 模型会话、Node 22 或真实部署后连续性；2026-10-23 的历史通过记录不补成本轮通过。 |
| 当前运行实例 | 2026-10-29 11:46:51 UTC 只读观察：3484 listener PID 40199 没有 host 启用环境变量，未发现独立 PTY host；检测到 14 个 Codex 原生控制宿主。后者不能作为独立 PTY host 的证明。本轮未重启现场。 |

原 ESM 源码文件 `src/agent-session-history/codex-native-conversation-transcript-location-for-resume.ts` 使用 main 已合入的实现，不再保留重复 dirty；对应真实 Node/tsx 回归仍保留。热重启退出编排、屏幕 checkpoint、输出偏移、排空、离线全停及进程组清理继续有用。

新增的两处同步适配仅补齐 Kimi 接管测试夹具的回收标记和真实追赶字节范围。另将旧 P4 的 hard-stop 断言对齐 main：旧托管者停止后拒绝继续写入，也不能结算迟到回执；持久未决状态由后继 runtime 补证。未削弱写前核验或未知结果不重发的门禁。

## main advancement 如何改变旧计划

| 主线能力 | 对当前方案的影响 |
| --- | --- |
| Codex 原生投递与持久确认（含 `13c670867`、`cc5202633`） | 直接复用原生投递、客户端消息身份和接受证据；handover 的排空必须保留 `before_first_transport_write` 阶段透传与提交可能开始的持久标记。 |
| 原生二次查询恢复、custody 与接受水位 | P5 不再另造 pending/sending 两态 outbox。确证尚未写入才允许重新尝试；已经可能提交的条目只读补证，保留原 key、TTL、session 与 incarnation。 |
| 通用故障自动续跑（`337cbf09a`） | 重新评估接管后的 `restartRequest=null` 与恢复协调器的接线，复用已有持久状态、停止语义和单飞；不能再添加独立的自动继续循环。 |
| 多独立会话与主会话交接（含 `32840f3f3`） | 每条会话保留 conversation-session ID、角色、主绑定与原生身份；host 接管不解除交接暂停，不把宿主卡 ID 当作原会话 ID。 |
| Codex writer 与 conversation storage 隔离 | 活会话沿用启动时实际绑定、配置目录、storage home、控制端点及 cleanup 所有权；接管不能按当前全局配置重算旧代启动参数。 |
| 所属命令执行与结果交回（`5290dc2b8`） | 部署诊断要覆盖独立执行 supervisor；runtime 停止恢复扫描不代表命令结束。后继只接续相同 execution/result identity，不能重复启动命令或交回结果。 |
| task closure、可视化、配置同步与进度统计服务 | 纳入统一、幂等的关停编排；先关闭新工作入口、等待领域动作收敛，再冻结及 detach 会话。 |
| 删除 Kanban RVF 专属编排（`4d6b396f4`） | 撤销旧方案中由 Kanban 调度 RVF token、boundary、automatic rewind、Land 再投递与阶段资格的方向。Kanban 提供通用等待、重启恢复和消息接受事实；RVF 自身负责候选与评审生命周期。 |

旧的“39→56 后刷新候选”诊断仍解释那次历史阻塞；本任务当前工作应以整合后的新候选重新审阅，不能复活旧 token 或复用旧冻结证明。跨仓 RVF 源码修改不在本轮授权内。

## 纳入 c258b：持久启用偏好

`c258b` 保存的用户原话为：

> 那么请创建一个 Cline Kanban Task，让 Hot reload默认启用的偏好能够跨重启维系

本轮用户另已明确要求吸纳其诉求。下列具体合同是根据该卡和现有实现整理的 Agent 建议，不冒充新增用户逐字指令。

### 持久配置和优先级

复用 `src/config/runtime-config.ts` 的全局、原子、加锁配置写入，按 runtime home 保存热接管偏好；不在 shell、tmux 环境和另一个配置文件中维护平行真相。配置更新必须保留其他偏好，global/project 两条写入路径都覆盖新字段，避免下一次写入丢值。

建议持久字段命名为 `agentSessionPtyHostEnablementPreference`，值为 `enabled | disabled`，缺席表示使用产品默认。机器可读结果另外报告偏好来源、受支持性、实际运行模式、host 就绪状态和降级原因。

生效规则按下列优先级裁决：

1. 平台与身份安全限制：自动端口、真正 remote-host、Windows、Electron 保持现有禁用条件；回环监听加 Tailscale Serve 不等于真正 remote-host。
2. 本进程的显式环境覆盖：保留 `KANBAN_AGENT_SESSION_PTY_HOST_MODE=enabled`，补齐明确的 `disabled`。环境覆盖不自动写回用户偏好。
3. runtime home 中用户持久选择：显式禁用跨重启保留。
4. 无配置且受支持的本机固定端口实例：默认启用。

旧规则中，非空且不等于 `enabled` 的环境值原本都会关闭 host。迁移保留关闭结果并提供“环境覆盖值无效”的诊断，不因引入新默认值意外启用，也不静默改写持久偏好。空值视为未提供覆盖。通过设置接口/CLI 明确保存选择，旧的 `enabled` 用法无需依赖同一个父进程一直存活。

启用偏好应在创建 workspace registry 和任何 PTY 之前加载。读取失败保留配置错误及可检测恢复条件；不能把未知配置当作用户禁用。运行中修改说明“用于下次启动/新建会话”的实际作用，不把已存在的 runtime-owned PTY 冒称已迁移。

### 启用意图、真实运行模式与恢复

诊断至少区分：持久偏好、环境覆盖、有效意图、强制禁用原因、当前 generation 是否可用于新会话、旧 generation 的存量托管、runtime-owned 降级会话、无法确认的归属。

复用 facade 当前的发现、连接、单飞重试和旧 generation 接管。把同一 runtime 身份的恢复条件、稳定证据指纹、实际启动尝试次数与下次检查时间持久化，重启后接续预算；不建立 RVF 专属恢复服务。同一稳定条件最多实际尝试 3 次，首次失败后间隔 5 秒、30 秒；耗尽后等待可检测变化，再恢复尝试。只读探测可以继续，不能通过反复重启重置预算并重复拉起 host。

等价核验来自：归属匹配的 socket 握手与 controller/listing、进程的启动身份、当前 summary/adoption record、持久日志中的原事件。socket 文件或历史 `host_listening` 单独存在不能证明当前就绪。host 活着却不应答时保持未知、自动补证，不另起竞争 controller。

保留现有可恢复降级路径并显式报告：新的 in-process 会话无法跨 runtime 保活，不能计入部署可保留集合。部署的“可安全热重启”结论必须由实际会话归属证明，不由默认开关推导。

## 建议执行阶段

| 阶段 | 交付 | 通过条件 |
| --- | --- | --- |
| N1 收敛当前 P4 | 在已吸收 main 的 57 路径候选上完成剩余兼容审计，检查所有新增后台服务、投递阶段和代次所有权；补齐打包态复验。 | 当前同步回归保持通过；原生提交未知不补发；checkpoint、cleanup、host 退休及离线全停保留严格身份门禁。 |
| N2 持久启用及诊断（c258b） | 实现上述偏好优先级、原子保存、启动前加载、机器可读诊断与跨重启恢复。设置入口复用现有运行时契约和写入漏斗。 | 清空临时父进程环境后仍按偏好启用；显式禁用有效；不支持原因可区分；并发写配置不丢字段；失败不误报保活。 |
| N3 补齐真正影响连续性的 P5 缺口 | 以最小持久启动描述恢复接管后的自动续跑资格，接入主线故障恢复；核验 hosted 会话、所属命令与资源采样的身份归属。 | 接管后故障能沿已有授权恢复；Stop/权限撤销停止依赖动作；原生/配置/会话身份变化不会误续跑；命令和结果均不重复。 |
| N4 接入 local-deploy 工作流 | 增加只读逐会话盘点、结构化部署前门禁、handover 请求/后继核验、host generation 与加载构建身份报告；更新项目部署 skill 和相关文档。 | 停旧 runtime 前逐条证明可保留；机器缺证自动补证并显示进度；存在 runtime-owned 活会话时不继续破坏性重启。 |
| N5 隔离自动化验收与当前候选审阅 | 全新环境恢复偏好、真实多进程会话连续性、消息不重复、故障恢复/并发/跨版本/回滚；按现行 RVF 入口审阅当前精确候选，reconcile PDV 定义。 | 有原生记录、进程身份与输入输出证据；所有未知如实保留；不把替身、旧评审或 transport 受理当作真实接受/完整通过。 |
| N6 获授权后的首次切换与部署验证 | 先将源码按相应授权完成提交与 local-main 集成，再按本次部署授权和现场归属执行切换、记录部署及验证 PDV。 | 源码、commit、local main、安装/部署和 PDV 分别报告；首次启用不能以“偏好已保存”跳过旧会话保护。 |

N1–N5 是同一完整交付的依赖顺序；不会为每一个内部步骤再次询问执行先后。本轮只完成同步必需的 N1 兼容部分与本计划，N2–N6 未因计划落盘而自动实施。

### N3 的边界与待核实项

- `session-manager.ts` 接管后仍显式清空 `restartRequest`，这是当前可证实的缺口。恢复必要启动事实时复用既有启动快照与 writer/storage 绑定，不重新计算旧代权限、model、settings 或原生 ID；持久材料不新增原始凭据副本。
- 主线已有通用故障续跑、原生接受 journal 和队列 custody。本任务只补接管接线与跨重启缺口，不另建恢复协调器。结果未知时读取同一客户端消息 ID 的原生记录与正文；确证未写入才允许重试。
- 现有回收期限读取已调用主线判据，当前回归通过；后续保持 `currentAgentProcessUserTurnIdleRetentionStarted` 与历史 handoff/activity 时间分离，不根据重放输出刷新历史或回收资格。
- 资源采样已经按各活会话 root PID 枚举；应先用真实 host 父子关系验证归因再决定是否改动，避免把共享 host 的全部资源重复算到每张卡。
- Kimi seeded home、Kiro agent 配置仍有旧计划提出的跨版本疑问。本轮只验证了 Kimi 的接管及启动门控回归；未来先隔离实测是否会重读共享配置，有证据再修，不把疑问当成已发生故障。

### 首次启用与本机启动链

当前 runtime 自持的 PTY 无法仅靠设置环境变量或写配置转移 PTY master。建议保留它们继续运行，准备候选并做隔离验证；真实切换只暂停依赖安全窗口的重启步骤，持久观察这些进程自然退出或既有会话回收完成后再核验。未取得明确的新打断授权时，不终止、resume 替代或伪报迁移。

本机持久 launcher 位于另一个仓库：`/Users/bominzhang/Documents/GitHub/tmux-plugins/run-cline-kanban-3484-service.sh`。本轮只读核对：它没有写 host 开关，已有 supervisor 锁，退出 130/143 停止，其他退出在 5 秒后重拉。N4 需用隔离 fixture 验证这一启动方式在全新父进程环境中能由 runtime 自己读到偏好；不再采用旧计划“只加 export”的修法。

若需要将 exit 75 的重拉优化为立即执行或修复 tmux/开机恢复入口，先确认 `tmux-plugins` 的编辑归属，再以有明确范围的外仓步骤处理。它不阻止本仓配置、诊断和隔离验收继续推进。本轮未改该 launcher。

### 部署步骤与降级恢复

- 构建前检查 `dist`、`web-ui/dist` 的 realpath，两处输出都隔离并显式设置 `KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY`；不触碰在线共享产物。
- 旧 runtime 的实时盘点区分：可证明由独立 host 托管、runtime-owned PTY/ACP、所属命令 supervisor、在途维护作业和未知归属。未知应触发只读补证和有界恢复，不省略条目。
- 只有“旧实例实际支持该入口且逐条可保留”时才发送 handover。请求响应丢失先查询原 runtime/marker/后继与会话身份，不能盲目重复退出动作；任何信号兜底都重新验证 PID 的启动身份与当前归属。
- 旧 host generation 保留存量会话，新 generation 服务新会话；构建身份可证，旧 bundle/端点/cleanup 描述仍被活会话使用时不清理。回滚兼容性须实测，不能声称任意旧 build 都可安全接管。
- host、原生会话或运行时不可读时，历史接受事实由归属匹配的不可变原生记录证明；后续执行资格按当前身份重新裁决。不会以当前工具不可用推翻过去已确认的接受。

## 自动化验收矩阵

| 场景 | 必须证明 |
| --- | --- |
| 全新固定端口本机实例、无临时环境变量 | 默认启用；从持久偏好加载；显式禁用跨子进程、redeploy 与等价开机恢复保留。 |
| 配置缺失、旧 env、无效 env、并发更新 | 优先级确定；旧关闭行为保留并给诊断；环境覆盖不写回；其他设置不丢失。 |
| 自动端口、remote-host、Windows、Electron | 保持能力限制；原因可查询；不绕过身份或单 controller。 |
| host 启动失败、socket 陈旧、旧 generation、controller 不应答 | 区分 disabled/degraded/unknown；有界补证和条件变化恢复；无重复 host 或错误会话接管。 |
| handover / SIGTERM / SIGKILL | 原 agent PID 与启动身份连续；输入输出继续；checkpoint 或缓冲回放的来源可证；不重发已有正文。 |
| Codex 原生多进程会话 | supervisor/TUI/app-server、native session、incarnation、控制端点和 writer/storage 绑定连续；cleanup 不越代。 |
| Claude 与独立协作会话 | 原生 session、角色、主绑定、hook 捕获时刻及交接暂停不变；窗口 Stop 按原事件落地。 |
| 排空超时、响应丢失、写前查询失败、两个恢复者竞争 | 已停止者不写入或结算迟到回执；原 key/TTL/custody 保留；可能提交只读补证；唯一执行、唯一结果交回。 |
| 自动续跑、人工 Stop、权限撤销 | 接管后的合法恢复自动执行；真正禁止立即停止依赖动作；机器等待不转为无依据的人工必答。 |
| 首次启用时仍有 runtime-owned 活会话 | 部署重启门禁拒绝中断，保留进度及机器可检测恢复条件；既有工作继续。 |
| launcher/父进程环境重建 | 通过隔离 HOME、固定端口、全新父进程自动化验证；机器断电不要求保留已不存在的进程。 |
| 真实部署 | 实际加载版本、同进程连续性、hook/IO、静态资产、原生模块及 PDV 分项核验；HTTP 200 不替代上述证据。 |

E2E 先使用自动化 API/CLI、隔离实例与浏览器工具。真实模型认证/能力暂不可用时保留未验证状态和自动重验条件，继续替身、原生持久记录与不依赖认证的验收；不要求用户提供机器可自行获取的日志或状态。

Node 支持下限仍为 22；本机现有原生依赖在 Node 24.12.0 验证。后续交付要在兼容的隔离依赖环境检查 Node 22，不能跨 ABI 复用本机 native binary 后把加载错误当成功。

## 同仓任务与明确后延

本轮通过 Kanban CLI 只读采集 506 个 active-column sibling task，无采集降级。检测到的文件交集为：

- `12fbc`（in_progress）：`api-contract.ts`、`session-manager.ts`、`app-router.ts`、`runtime-api.ts`；当前 WIP 包括 Codex 配置同步，原任务标题不能替代当前文件核对。
- `f1dfd`（in_progress）：`api-contract.ts`、`runtime-server.ts`、`app-router.ts`、`runtime-api.ts`；任务创建与跨项目归属。

本轮未改对方 worktree、未合并其未落回 main 的代码。后续实际实施前刷新这些路径的主线增量；如需再次同步，按届时真实授权执行。软重叠为 `c258b`、`9c0dd`、`066c1`、`31f5d`、`5f9ce`、`de27e`：

- `c258b` 的持久启用需求由 N2/N4/N5 吸纳，卡片保持 Backlog；已登记 requirement-origin 关系。
- `9c0dd` 的退出确认修复已包含在现有 P4 WIP；后续审阅覆盖它，不因本轮测试就关闭该卡。
- `066c1` 的 attach 超时后暂存输出残留没有纳入当前修复；在 N1/真实接管验证中检查是否影响本目标，有直接依赖证据再明确纳入。
- `31f5d` 的历史 RVF 投递问题与已退役编排相关；旧事实保留，新方案遵循当前通用恢复边界。
- `5f9ce` 的 graceful redeploy 分析、`de27e` 的闲置会话展示/回收设计作为参考；不复制其实现或自行修改回收期限。

远端模式 hook token 持久化、ACP pipe 会话保活、终端 inspector/attach、新的进程内热替换和零停机蓝绿均后延。它们不是受支持本机 PTY 热重启与持久偏好的必要前置。Cline SDK 继续按仓库约定停止维护。

## 持久证据与历史入口

本轮证据目录：`/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/task-dbfe4-main-refresh-and-c258b-plan/20261029T113544Z/`。

- `dirty-before-manifest.json`、`dirty-before-absorption/`、两份 patch：本次同步前原 WIP 的原字节与 hash。
- `rvf-token-audit.json`、`old-rvf-handoff.md`、`old-rvf-boundary-recovery-state.json`：旧候选没有完成评审的证据。
- `one-way-absorption-state.json`、边界/锁回执、冲突三方快照和 `wip-conflict-resolution-record.json`：固定基线、保护、恢复与整合过程。
- `guarded-unit-regression.log`、`guarded-isolated-integration.log`、两套 typecheck、前端测试与 Biome 日志：本轮结果；单元回归首次失败日志单独保存，未覆盖为通过。
- `current-runtime-host-mode-readonly-observation.json`、`sibling-task-survey.json`：只读现场快照，PID 和任务活动是带时刻的观察。
- `PREVIOUS-PLAN-BEFORE-20261029-REFRESH.md`：被本文件取代的完整旧计划。
- 2026-10-23 的 P4 报告：`/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/task-dbfe4-p4-completion-20261023/P4-COMPLETION-REPORT.md`，仅作历史证据。
- 原 Claude 交接：`/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/task-dbfe4-main-session-handover/794ce815-5a01-4c8e-be48-c446d5038ea1/HANDOVER.md`，其中计划批准状态 unconfirmed 不构成后续授权。
- `c258b` 事故证据：`/Users/bominzhang/.cline/kanban-deployment-backups/20261028T202733Z-local-deploy/hot-restart-session-preservation-failure-investigation.txt`；本轮使用当前源码和进程只读观察补核，未把历史 PID 当作当前事实。
