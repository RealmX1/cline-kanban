# Codex profiles、自动共享与原进程采用

每代看板 Codex 原生进程持有独立、持久的 `codexConfigurationWriterBinding`。运行时重启接管同一绑定；原生进程替换时创建新的 writer，并保留旧副本与尚未合并的本地决定。旧共享目录只初始化一次，之后不再刷新其 `config.toml`，避免最终检查与原子替换之间覆盖原生 `/hooks` 保存结果。

配置目录在运行时 HOME 下的 `codex-configuration-writer-bindings-and-sync/writers/<writerId>/configuration-home`。绑定清单记录配置来源、历史和 SQLite 目录的物理身份、启动基线摘要与共享版本。`sessions`、`archived_sessions`、`thread-writer-locks` 使用核验归属的目录桥接；SQLite 继续使用原目录，认证仍引用原来源。配置文件本身必须是普通文件。历史查询、fork/resume、原生写锁与存储迁移继续依据历史归属，不从配置副本反推另一段对话。

历史转录中的 writer home 先按物理路径识别，再核验持久绑定清单、历史目录身份及历史与写锁桥接；HOME 的软链或等价路径不会改变历史归属。summary 缺少历史目录字段时可从已核验的清单恢复；普通旧 home 仍以原生转录归属为准。仅有目录形状、清单身份不符或桥接被替换都不能取得历史桥接资格。

共享默认保存于看板内部的 `configuration-sync-state.json`，权限为 `0600`。外部配置只在首次初始化时一次性导入，此后由 Kanban 独立维护。独立历史 helper 与无状态 Codex 执行器也使用自己的配置副本，不能通过辅助进程刷新活会话。

## 一次性初始化与外部设置边界

每个来源在 `source-initialization-snapshots/<sourceIdentity 的摘要>/` 保存初始化清单、配置文件原文与捕获归属。清单先原子写入并同步，再构建可恢复的派生配置文件；来源状态保存 `configurationInitialization` 的路径、摘要与时间。初始化在清单提交后中断，重试仍使用同一清单，不重新导入变化后的外部内容。快照丢失、摘要或来源不符时保持未知，目录恢复后由启动或五秒补扫重验。

已有来源优先使用经完整 writer 清单及目录身份核验的 Kanban 副本建立快照，随后覆盖为已接受的 profile 字段。新建、重启和辅助 writer 使用快照、profile 或核验后的父会话副本；历史存储目录也不会重新复制后来新增的外部配置。配置字段迁移不更改原 writer 清单与启动事实。

外部 `config.toml`、`*.config.toml` 与 `hooks.json` 的设置变化不再登记审批或传播决定。`desktop.*` 不进入可共享、可编辑字段，所有 profile 的桌面设置及对应版本键均从当前投影移除。来源目录的身份仍须核验，外部配置文件内容及可读性不影响内部提案资格。认证、skills、插件目录和安装生命周期继续采用既有机制；可动态变化的内部或插件定义仍经过来源与摘要校验。

旧外部及 desktop 记录以 `settingsIsolationArchivedAtMs` 归档。原始值、定义观测、已应用回执及失败历史保留；未执行完的目标保存取消前状态与原因后转为不适用。审批、共享冲突、目标冲突、同步和重启采用入口均拒绝重新激活这些记录，已接受的 Kanban 默认继续保留。

## Profile 与字段归属

`CodexConfigurationProfile` 是看板内具名、持久的配置集合；Task 与主、侧会话分别保存 `codexConfigurationProfileId`。创建和编辑 Task 共用选择器，侧会话默认继承 Task，可另选同来源 profile。设置页支持复制创建、重命名、默认选择、按字段修改及当前会话重新绑定。profile 不改变认证、历史目录或 SQLite 归属，不回写普通 Codex 的全局配置。

| 设置 | 会话中修改后的默认行为 | 范围 |
| --- | --- | --- |
| 普通可共享字段 | 自动反馈、更新并广播 | 所属 profile |
| 模型、Reasoning Effort、完整权限 | 仅作用于当前会话，提供十分钟反馈机会 | 明确反馈后更新 profile 并广播 |
| hook 信任与撤销 | 复用已确认决定 | 同来源、同定义的所有 profile |
| hook 启用与禁用 | 自动反馈、更新并广播 | 所属 profile |

模型、Effort 与权限按三组保存局部例外。profile 明确更新某组时才取代该组局部值；更新其他字段、重命名或切换页面不会清除局部选择。完整权限同时保存审批、沙箱、工作区写入与命名权限配置，不能仅从 Full Access / Ask 标签重建。Task 用 `codexConfigurationPermissionSelectionSource` 区分完整 profile 权限与 Task 局部档位；界面展示权限来源和当前会话实际有效档位，只读侧问继续受只读约束。配置文件变化只表示选择已保存；权限展示先退回待核验，再由变更之后、身份与工作目录匹配的原生回合上下文确认。较旧回合、其他会话或不同权限不能冒充当前采用，待核验时间跨重启保存。

十分钟期限在第一次观测时固定为 `feedbackExpiresAtMs`，同一会话同组只留最新建议。关闭页面、折叠、重连、服务重启均不延长期限。服务端每次受理前检查期限、版本和当前完整字段；过期、被替代或 profile 对应组已更新的建议不能提交。客户端按绝对期限退出待反馈列表，离线时也不会留下可提交按钮。反馈一次完成更新和广播；不反馈保留局部选择。

启动基线 `launchBaselineFields` 不变；合并使用 `mergeBaselineFields`、最近观测 `lastObservedFields` 和逐字段 `fieldVersions`。所有 profile 修改经持久 store 锁串行受理，不同字段分别合并，同字段以最后受理的有效版本为准。A→B→A 仍用字段版本使旧传播失效。已登记传播写入的文件变化不会反向形成新决定。休眠副本恢复时先追上当前 profile，再保留未被对应新版本替代的局部例外，防止旧快照回流。

## 跨 profile hook 信任

信任账本以配置来源身份、规范化 hook 来源键和定义摘要联合定位，保存定义哈希、内容哈希或明确撤销。仅内容重新确认也会登记并传播，目标 profile 的启停保持独立。旧记录缺少内容事实时保持未知，不从当前文件补造；插件缺内容的正向决定不授予信任，任何已有内容约束也不降为旧格式信任。普通文件 hook 已知无内容的确认仍兼容；撤销清除两个哈希。定义变化只生成来源提示；新定义仍需原生确认。确认后，同来源同定义的其他 profile 自动复用；先观察新定义、后收到确认的目标也会由周期补扫追上。

传播前同时核验目录身份、规范化定义摘要及原所有者 `hooks/list.currentHash`。原生插件、外置 profile、旧内联 profile 的来源规则保持一致；`<session-flags>`、认证、环境变量、机器路径、历史身份与运行时注入不进入共享字段。管理页不能通过编辑 JSON 授予或撤销信任，信任必须来自原生确认。

## 真实采用、安全续接与恢复

活副本只经原 app-server 的 `config/batchWrite` 写入，携带配置层 `expectedVersion`，并核验端点代际、原生线程、配置文件及源定义。操作身份与“提交可能开始”先持久保存。受理、磁盘保存、原进程重载和后续启动实际采用分别记录；文件内容、另一进程重载或 `hooks/list` 不能冒充原线程采用。

Codex CLI `0.164.0`、`0.165.0` 的普通主配置 hook 状态已核验可原进程热更新。静态模型、权限、插件生命周期及未验证版本保留待采用，在安全时自动续接同一原生会话 ID。必须确认本代存活、回合已结束、无未提交草稿、无待答问题、无投递占用或 Stop 限制；搁置、已结案、垃圾桶任务不能被广播唤醒。

Codex CLI `0.165.0` 的插件 `hooks/list.currentHash` 为 `定义哈希/内容哈希`。继承已有决定时，若原始状态包含 `trusted_content_hash`，两个哈希都必须与原生完整指纹匹配；只匹配定义不能授予内容信任。旧格式仍保留原始事实，不从当前插件文件补造内容确认；禁用和撤销继续独立处理。仅内容确认的变化显示为「内容信任绑定」。

纯禁用仅将 `enabled` 改为 `false`，保留目标原有全部信任字段，因此不要求变化后的内容先重新获得信任。配置版本与完整状态冲突检查继续生效；同时修改信任字段的禁用决定仍须通过完整指纹门禁。

双哈希目录兼容、验证及 Codex 原生 Git 元数据限制见 [实现与依赖边界](research/codex-plugin-hook-dual-hash-trust-implementation.md)。本仓库修复不改变 Codex 的插件内容指纹算法。

Codex `0.166.0` 的新 writer 同源共享 `plugins` 与 `.tmp/marketplaces`，并以物理来源域协调原生更新，避免辅助进程将相同 revision 误作首次安装。未知能力与旧活进程保留兼容布局；双哈希批准不自动重签。目录绑定、跨 profile 中断恢复及原生验收见 [同源插件安装与原生更新协调](codex-source-shared-plugin-installation-and-native-update-coordination.md)。

缺原进程端点的旧会话可从绑定转录取得等价完成证据：核验原生身份、工作目录、最新完整完成事件和文件读取期间稳定性，任何后续执行、用户消息或不完整记录均使证据失效。续接前再次核验转录、语义代际、输入序号和双路空输入框。证据不足保留具体恢复条件，继续其他会话，条件恢复后自动接续。

停止原进程到新输入框就绪之间的新输入持久写入专用 `retained-terminal-input-during-profile-adoption`，只交给同一原生会话的新进程。投递前先登记提交状态；回执不明时按原生接受游标补证，不能盲目重复发送。启动失败或运行时重启后，从同一持久启动记录自动继续；跨字段共用三次启动上限，profile、原生二进制或来源证据改变后恢复资格。显式 Stop 持久取消后续自动启动，输入记录保留供后来明确续跑；界面显示保留字节与原因。

同一写入或续接证据最多三次，次数与证据指纹跨重启保存。端点、原生进程、配置或完成证据变化后重新取得资格。回执丢失先核验磁盘；值已保存时只补幂等重载。profile 绑定另有持久待办，Task 写入中断后自动补做，幂等回放不能误报绑定已完成。目录监听、启动扫描与五秒周期补扫互为替代路径；不可读来源保持未知状态并公开 `observationProblem`。

## 升级与历史

schemaVersion 3 从已经采用的共享字段建立兼容 profile，不同来源分别绑定。已有 writer 的模型、Effort 和权限保留为局部选择；恢复时补入旧 Task 模型及原启动参数的 Effort，但已被 profile 对应字段明确更新的选择不再恢复。局部覆盖只改变记录的字段，删除操作保存显式标记，跨 JSON 持久化不会丢失。旧 manifest、副本、历史与存储路径不改写。旧待审批提案归档，不因升级自动广播。已批准传播、冲突值、明确处理选择、保存与重载事实继续保留，历史事实与当前覆盖独立展示。

显式切换 profile 的绑定副作用跨进程换代补做，当前 writer 也追上已接受的归属。权限广播只更新仍属该 profile 的权限来源，不能通过退休 writer 的旧回执把当前会话或 Task 绑回旧 profile。

没有 writer 的旧共享会话，只有能确认原生身份与原存储归属时才登记迁入进度；安全时自动续接并取得独立配置副本。缺失归属的旧会话保留现场，等待自然启动补齐。App Recents 不属于此配置调整的验收范围。

界面保留顶栏覆盖式通知、8 秒自动收起、键盘焦点、隐藏导航和阅读位置。普通变更进入历史；模型、Effort 与权限进入限时待反馈。隐藏与折叠只改变展示，不重置期限。来源定义提示的「标记已读」只处理提醒，不改变设置或授予 Hook 信任。

通知与设置页的来源计数都只统计 `acknowledgedAt === null`。已标记已读的来源进入历史，显示原处理时间并移除操作按钮；稍后处理的来源也进入历史，保留「标记已读」入口。同一来源出现新观测时重新成为未读，不把旧处理套用到新版本。

来源操作按条目单飞，不占用设置或 profile 的全局操作锁；通知和设置页共享同一 workspace 的等待状态。来源操作与状态查询分别使用独立 HTTP 请求，保留 workspace 请求头和页面 nonce 的重取机制，避免同批慢请求阻塞回执。每次请求有 15 秒逻辑预算并尝试取消底层请求；超时只表示回执未知。之后最多三次补读，间隔为立即、1 秒、3 秒；仍为原版本时以原请求、原版本和原幂等键最多重送一次。已处理、新观测、相反处理或明确冲突均不重送旧意图。

共享来源控制器的归属覆盖仍被 Hook 持有的引用，而不只覆盖当前订阅者：禁用 Hook 保留实例期间，最后一个订阅退出不会驱逐该 workspace 的所有者，新消费者与重新启用的消费者仍共享单飞及冻结身份。最后退出只取消本代请求、移除监听并清空内存快照；再次订阅从持久记录先补读恢复。注册表使用弱引用，实例不再被持有后可回收。

冻结请求、workspace、观测指纹和已用重送次数保存在独立 localStorage 键 `kanban.codex-configuration-unconfirmed-source-observation-actions.v1`。刷新后先补读，耗尽预算后保留未知与「重新核验」入口，在线恢复、运行时流重连或页面重新可见时自动补读；普通重绘不重置重送额度。所有查询和 mutation 快照按 workspace 生命周期及单调 revision 接收，旧回执也不能清除新版本操作。初次读取失败时显示读取错误和恢复入口，不持续显示读取中。

## 新原生会话的权限继承

本任务实施期间，用户报告多个会话从 Full Access 变为 Ask for Approval，以及看板仍显示 Full Access、原生操作却需要审批。现场账本没有权限字段被传播的记录；当前实施会话的原生 ID 与启动核验的 ID 不同，新会话首个回合是 `on-request + workspace-write`。

隔离的 Codex CLI 0.164.0 实验确认：仅通过 thread RPC 恢复旧会话为 `never + dangerFullAccess` 时，同一 app-server 再创建新 thread 仍使用 `on-request + workspaceWrite`。现在受管宿主同时获得已选择且原生配置支持的权限默认，原有逐会话核验继续保留，计划转实施创建的新 thread 能继承 Full Access。专用 CLI 旗标继续优先于配置覆盖。

权限配置的 `-c` 覆盖保持原始先后顺序，较晚的点路径限制不会被较早的整体表覆盖；专用 CLI 旗标最后生效，并支持 `-s=read-only`、`-a=never`、`-c=approval_policy="never"` 等短选项附加值。新建与恢复宿主使用同一份配置分流，权限配置不再重复透传。

0.164.0 配置加载器拒绝旧 `untrusted` 字面值，原生 TUI 也拒绝 `-a untrusted`。逐 thread RPC 仍能为单个 thread 设置该策略，不能据此证明宿主为未来新 thread 提供同样默认值的资格：当前有效选择为 `untrusted` 时，在能力探测和目录分配之前明确拒绝受管启动，避免过滤后静默继承更宽松的全局默认，也不伪造等价配置。后项明确选择受支持的审批策略，或专用旗标覆盖该旧配置时，仍可使用受管宿主。显式 `--remote`、`--no-daemon`、profile 等既有旁路继续保留原生 argv 与原生错误。

原有只读 fork 和显式宿主旁路保持原生门禁。此处实验覆盖新 thread 的继承和真实后续回合，不把启动回执单独当作所有未来回合的权限证明。

## 只读发起者追踪

运行时启动基础采集，复用轮转 JSONL 日志，记录已知原生请求的用途、请求 ID、进程身份与核验后的 writer / 任务归属，并观察配置文件、hook 定义和插件缓存目录的物理身份、目录版本与内容摘要。不会为诊断主动调用 `plugin/list`，不会保存配置原文、认证或命令参数正文。

writer 归属补证在独立异步上下文中执行，所需卷观察先在事务之外准备；业务请求和连接关闭不等待诊断的慢查询。文件快照中的 dev / ino 只描述观察事实，不能代替目录身份与执行资格。来源、manifest 或桥接无法核验时记录未知，后续请求按恢复后的证据重验。

独立脚本支持先监听、核验就绪、采集初始快照，再启动命令，也可不带命令附着已有环境：

```sh
node --import tsx scripts/trace-codex-configuration-and-plugin-cache-change-initiators.ts \
  --evidence-directory "$HOME/.cline/kanban/codex-configuration-initiator-evidence/example" \
  --target-home "$CODEX_HOME" --duration-ms 60000
```

追加 `-- <命令> <参数…>` 可在监听就绪后启动命令。相同证据目录持有独占锁，并在 spawn 前原子持久保存提交可能开始事实。再次运行接续日志和快照，不重复执行先前的命令，提交结果不明也不盲目重启。证据目录须在被观察目标之外，交接时使用持久目录。

`--macos-write-events` 是独立排障模式，通过独立进程组运行系统 eslogger，收集 write / create / rename / unlink / 已修改 close 事件。需要 root 和负责进程的 Full Disk Access；权限依据见 [Apple 官方说明](https://developer.apple.com/videos/play/wwdc2022/110345/)。脚本用证据目录中的就绪探针确认订阅实际可用，再开始初始快照；探针不写入目标配置或缓存。退出时只停止自己拥有的系统采集进程组。

报告严格分为已证实的文件写入进程、可能的发起请求与未知。系统事件的 audit token、PID 版本和启动代际区分短命进程与 PID 复用；时间相邻只产生候选关联。文件通知和摘要变化不能证明实际写入者。系统序列缺口、格式异常、权限不足、目录不可读及采集预算耗尽都会留下覆盖缺口；基础采集继续，同一权限证据最多三次，权限能力指纹变化后自动恢复资格。所有快照有读取预算，文件变化最多三次补扫。

系统级权限尚未具备的环境只能验证降级路径与事件归一化，不能宣称查明真实写入者。插件缓存物理隔离仍属后续设计，本轮保持现有插件安装生命周期。

## 工作流阶段接缝

既有 RVF 快照增加内容寻址的 Skill 执行闭包，保留正文、references 和 helpers。插件 Skill 以其安装包为边界，普通 Skill 以自身目录为边界；不复制 `.git`、`node_modules` 和解释器缓存，外部解释器及原生二进制继续遵循既有安装与版本核验。闭包采集有文件数和字节数上限，文件变化或循环软链不伪造成功。

land/base 的阶段认领记录实际配置摘要、writer、启动共享版本、既有 Skill 快照摘要和通过逐文件验证的闭包入口。自动收尾提示要求使用认领返回的持久入口与相对资源。已认领阶段复用原认领；新阶段重新核验。Stop 和明确撤销检查继续先于执行资格，不因固定版本而放宽。旧阶段缺少新增字段时保留兼容路径。

这是本任务实现的接缝，不替代 RVF 原 run 的历史账本，也不建立独立的跨仓发布平台。来源 Task `7494b` 的原 `RVF-002` 及失败记录保持原样；本任务的验证不能冒充原 run 已收尾。

## 扫描、恢复和只读查询的开销边界

`getState()` 只读取持久配置状态并生成展示投影，不触发或等待扫描、原生重载和安全续接。运行时初始化、目录监听和五秒补扫负责独立收敛；设置修改接口仍观察最新事实并推进传播。仅当整批均为来源提醒的 `confirm_source` / `defer` 时，跳过前置全量观察及后置恢复，保留存储锁、版本检查、逐项持久化、幂等回执与发布。浏览器按 workspace 和 revision 接收快照，并精确隐藏到期提醒；服务端提交仍重新校验期限。

恢复阶段先过滤出含 `accepted`、`pending_reload`、`pending_next_start` 目标的记录，再按撤销/禁用优先级和版本排序。已应用、冲突和不适用目标不再产生逐目标状态读取。`accepted` 应用后转为待续接仍在同轮继续；执行前的最新来源、定义、代际、输入占用和三次重试门禁保持原样。

后台观察在共享存储锁内保留持久原文，完成迁移和观察后比较最终序列化正文。内容完全一致才跳过正文写入、临时文件创建、原子替换和 `fsync`。首次创建、迁移，以及没有 `revision` 变化的文件清单等元数据变更仍保存。明确操作及其幂等重试继续完整持久化，补齐此前原子替换成功但同步或回执失败的情况。

这三项优化不提供索引或历史分页。当前仍需解析整份状态、遍历 writer 与历史的关联、生成完整响应和渲染历史；规模核验及后续建议见 [同步效率核验](codex-configuration-sync-efficiency-verification.md)。

## 配置反馈的来源与完整比较

设置页与通知按同一 profile、同一字段归并待反馈项，完整权限组作为一个选择。服务端生成 `candidateFieldGroupKey` 和基于未脱敏、未截断完整字段及定义的 `completeCandidateValueDigest`；相同候选合并来源，不同值分别展示。到期、被替代或归档的来源退出当前候选，原始历史与版本各自保留。

当前看板默认旁是「保留当前默认」，每个候选旁是「采用此值并广播」，手机中按钮仍留在对应值的区块内。保留默认处理当前展示的全部候选，不改会话局部选择；采用则复用 profile 更新与广播，收口同组旧建议。修改前进入来源历史，与当前默认完全相同的值合并展示。目标冲突的两个操作分别放在来源决定和目标决定旁。权限反馈保存全部相关字段的旧值、新值及删除事实；旧记录未保存的关联旧值明确为未知。

采用操作固定已展示的原始记录、版本及当前默认摘要。同值来源暂不可核验时最多尝试三个已展示的等价来源，不自动切换到其他候选；版本变化、冲突或回执未知时补读并保留真实状态。多个不同候选的组须逐组明确选择，批量通过不会自动挑值。旧服务端未提供完整摘要时保留独立候选，不按展示文案推断相等。

`getCodexConfigurationChangeDetails` 是只读 query，以 `changeId`、`expectedVersion` 和可选 `targetWriterId` 加载完整比较。目标必须属于该变更。服务端统一脱敏与生成文本，完整 Hook 指纹按需返回；没有采集过的 Hook 代码正文不补造。展开失败保留关键差异，连接恢复、页面重新可见或运行时重连时自动重验，也可手动重试。

修改发起者与检测会话归属分别保存和展示。新记录保存任务标题、项目、任务 incarnation、会话与运行代次快照，以及共享字段版本和对应变更引用。只有明确的 profile 编辑操作可标为已确认操作来源；文件观测、自动采用、writer 归属及相同配置值均不能证明修改者。

历史归属通过持久 writer 与同代会话补证，扫描时只补齐缺失快照。任务链接按项目、task ID、incarnation 验证；迁移依赖身份账本中的位置别名，再核对当前 board。删除、ID 复用或项目不可读时保留快照并隐藏链接。来源查询单飞且界面等待上限为一秒，未完成只隐藏当前链接，不阻塞其他记录；后台读取完成后与五秒扫描自动接续，不重复执行配置选择。

`sharedConflictEvidence` 固定冲突发生时的字段、版本与变更引用，当前共享值另行读取。新界面在解决共享冲突时提交 `expectedSharedValueDigest`，权限组绑定完整字段集合；并发更新使旧选择失败，刷新后须重新选择，不自动重放。未带新摘要的旧请求继续执行原冲突门禁。目标冲突继续绑定 `expectedTargetValueDigest`，磁盘保存、原所有者加载和实际采用的既有校验保持有效。

## 可重放验证

普通单测和 UI 测试：

```sh
npm run test:guarded -- --project precommit-safe test/runtime/terminal/codex-configuration test/runtime/terminal/codex-profile-adoption-native-turn-completion-evidence.test.ts test/runtime/terminal/session-manager-codex-profile-safe-adoption.test.ts test/runtime/terminal/codex-conversation-storage-home.test.ts test/runtime/terminal/session-manager-codex-conversation-storage.test.ts
npm run web:test -- src/components/codex-configuration-sync.test.tsx
npm run typecheck
npm run web:typecheck
```

真实 Codex 使用隔离 HOME 和本地合成模型响应，不调用外部模型：

```sh
KANBAN_CODEX_NATIVE_CONFIGURATION_SYNC_SMOKE_BINARY=/absolute/path/to/codex \
KANBAN_CODEX_CONFIGURATION_SYNC_EVIDENCE_DIRECTORY=/absolute/persistent/evidence \
npm run test:guarded -- --project runtime-integration test/integration/codex-configuration-writer-sync-native.integration.test.ts
```

打包态浏览器回归使用隔离 Git fixture、HOME、运行时和 Chromium，覆盖桌面、手机、横屏、Focus View，以及顶栏/看板/终端容器的开合与新提醒前后几何（误差 ≤1px）、遮挡、焦点和反馈请求：

```sh
PLAYWRIGHT_BROWSERS_PATH=/absolute/path/to/playwright-cache \
KANBAN_CODEX_CONFIGURATION_SYNC_PACKAGED_CLI_PATH=/absolute/isolated-build/dist/cli.js \
KANBAN_CODEX_CONFIGURATION_SYNC_BROWSER_EVIDENCE_DIRECTORY=/absolute/persistent/browser-evidence \
npm run test:guarded -- --project runtime-integration test/integration/codex-configuration-sync-packaged-browser.integration.test.ts
```

构建前分别核验并隔离 `dist`、`web-ui/dist`，显式设置 `KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY`。构建 Node 必须与所用原生依赖的 ABI 相符，不重编共享依赖来修复单个任务的环境漂移。
