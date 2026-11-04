# 部署验证脚本的独立执行与恢复

自动脚本由 task-command 的独立监督原语派发。PDV 只复用独立进程、进程代际、派发屏障与回执，不接入 command 的 park、消息投递或 agent 会话保活。

## 身份与持久边界

公共 `run.status` 仍是 `not_run / running / passed / failed / errored / timed_out`。新增字段均可选，旧运行时契约仍可解析旧数据。未确认退出时始终保留 `running`，`recoveryObservation` 说明原因；取消请求、心跳过期和 TTL 都不是退出事实。

每次受理在 PDV 状态锁与 execution admission 锁内分配 UUID `verificationExecutionAttemptId`，保存：workspace、部署起点、taskId、真实卡片 `taskIncarnationCreatedAtEpochMs`、PDV 条目 `postDeployVerificationTaskInstanceId`、itemId、定义指纹和绝对 deadline。PDV 条目 UUID 保护条目重建，卡片 createdAt 保护同 taskId 的卡片换代，两者不能互相替代。

API 捕获本次请求所见的定义指纹，受理锁内再次核对。等待读取卡片身份期间若定义已变更，本次请求不分配 attempt、不派发脚本，返回按当前定义重新运行的原因；不能将旧定义的较长 deadline 绑定给新定义。

sidecar 位于 runtime home 的 `verification-execution-attempts/<attemptId>/`。`attempt.json` 保存启动阶段、原始 boot、后续首次可信 boot 观察基线、取消意图、恢复预算与终结结果。监督入口、启动材料、唯一 claim、监督进程身份、派发屏障、进度和终结回执保留在同目录。写入采用 durable 原子替换；监督者的原件完成文件与目录 fsync 后才继续，脚本派发前先保存身份与屏障。同 nonce 不重派，重启后的运行时只观察原件。

脚本定义指纹覆盖核对依据（kind、script、引导步骤及预期观察）。label、定位和清理文案不改变核对依据。脚本文件原地改写的完整资产版本化不在本次范围；重注册会撤销该 verificationId 的旧延后清理请求。

## deadline、退出证明与输出

RPC 的首次只读定义查找最多使用 5000ms；超界明确未受理，迟到读取没有继续受理或派发的路径。定义可读后，以请求开始时间计算绝对 deadline，加 5000ms 为完整 RPC 上界，覆盖启动、validator、文件与 attempt 锁读取、观察和最终结果应用。超界交回内存中的已知恢复快照；独立监督继续管理 deadline，恢复器负责持久收口。超界不改变成功条件，也不授权再次派发。

监督者追踪脚本进程组、已确认父链和本执行独有的原生环境键 `KANBAN_OWNED_COMMAND_EXECUTION_NONCE`。原生环境读取使用 NUL 键边界，不使用 `ps` 拼接展示的环境文本。快速双重 detached/setsid 后代即使已 reparent，仍可由该归属补证。信号只发给启动代际仍匹配的归属进程。

macOS 使用按源码指纹缓存的 libproc 探针，一次原生调用枚举进程并在同一 helper 内围绕 parent/环境观察核验前后内核代际，避免 ps 枚举后再逐 PID 派生 helper。读取内核 `p_uniqueid`、原始父代际与 NUL 环境键。`p_uniqueid` 在 exec 前后保持稳定；新 PDV 的比较和信号资格必须有精确原生代际，不能退回秒级 lstart。旧 task-command 保留兼容比较。派发前固定精确祖先和已有后代集合，后续不会因 reparent 重算其归属。原始父代际只作出生来源补证，不将当前 PPID 冒充出生回执。[Apple XNU 身份定义](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/proc_ro.h)、[原生查询实现](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/proc_info.c)

Linux 新 attempt 在同一独立 Node 监督者内加载私有 N-API addon，派发业务 child 前设置并 GET 核验 `PR_SET_CHILD_SUBREAPER`。边界原件绑定 nonce、监督者精确代际、boot 与 PID namespace。快速 double fork / setsid 后代即使清空环境，仍留在该监督者的内核后代边界。根 child 的 Node exit 事件已收到、同步查询结束后，addon 使用 waitid/waitpid 回收收养僵尸；只有内核返回 ECHILD、边界连续有效且没有已证存活归属时，才写终结原件。外部验证项的晚生 child 或新 runtime 不属于该边界，可以独立完成。[Linux subreaper 语义](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html)

Web runtime 只编译私有缓存，不加载 addon 或改变自己的收养属性。Linux 需要 `cc` 和当前 Node 安装的 `include/node/node_api.h`，使用 N-API 8、架构与源码指纹隔离；不重建共享依赖。Darwin 使用 `/usr/bin/cc` 编译原生探针。编译产物先写唯一 staging 再换入，失败不留下可误复用的半成品。能力不可用时脚本不派发，保留明确的未派发/错误原件；能力恢复后可重新受理，原 attempt 不重派。原生缓存源码可再生，不是跨任务交接材料。

新内核边界绝不追认给旧 attempt。探针不可用、身份不可读、边界失效或监督者硬退出且缺少完整归属时，保留具体 unknown；不根据 owned 列表为空、取消意图或心跳推断退出。Darwin 现场缺少精确出生来源的无归属进程继续阻止收口，公开 PID、原因与自动重验条件。正文结束且只剩未知归属时，监督者把同一语义证据最多三次、间隔十五秒的预算持久化到 `post-script-ownership-recovery-budget-<nonce>.json`，公共观察合并显示该预算。预算耗尽后只批量观察已知 PID 的原生代际与原始父证据，不再反复枚举全机或读取环境；证据变化自动重新补查。deadline 到点优先触发取消，活脚本与已证存活后代仍维持正常 deadline 监督。

确认所有归属执行已退出、收到同 attempt 的终结原件、明确证明监督进程从未派发，或观察到可信的真实 boot 变化，才可收口。`supervisor-launch-aborted-<nonce>.json` 只在启动锁内确认尚未调用 spawn 时保存；已写派发屏障后发生崩溃仍保持未知。

stdout/stderr 在监督者内只保留有界尾部，公共摘录最多保留尾部 4000 字符及截断说明。PDV 不把完整脚本输出累积到 Web 服务内存或日志文件。

## 自动恢复与预算

运行时必须在启动时接入 `startVerificationExecutionRecoveryLifecycle({ readCurrentTaskIncarnationCreatedAtEpochMs })`，关闭时 `await stop()`。启动立即扫描，此后每 15000ms 单飞扫描；不依赖浏览器。回调从当前权威 workspace 状态读取 card.createdAt，可信缺席返回 null，读取失败抛错。API 的派发与结果应用也在持锁时重新调用该身份读取，不能使用提前缓存的 createdAt 冒充当前身份。

同一语义证据主动补查最多三次，间隔十五秒，预算持久化。心跳 `updatedAtEpochMs` 与输出不重置预算；回执、归属进程代际、启动材料或 boot 的真实变化才触发新一轮补证。预算耗尽后仍被动观察这些证据。正文 returncode/signal 已出现或原生归属未证时，deadline 前即显示“正在核验退出”。确认 owner 退出后再读最终回执，优先消费两次观察之间晚到的有效结果，再用中断兜底。

旧无 owner 的 running 迁移为 `legacy_unowned`，不猜历史 PID 或卡片 incarnation。若迁移时 boot 不可读，后续首次可信值只记为 `firstTrustedObservedSystemBootIdentity`；之后再发生真实 boot 变化才能证明旧执行已退出。年龄、新 runtime 启动或当前卡片 createdAt 都不能补成历史事实。

恢复每轮筛选公共 running、非 terminal 与 pending cleanup。已应用且无待清理的 terminal 历史跳过；公共状态批量应用，避免对每个历史 attempt 重读大型全局状态文件。

## 定义变更与资产清理

定义修改、删除、条目失效和资产清理先保存取消意图。退出确认前保留执行材料与资产，其他验证项可以继续执行。延后资产清理与定义注销在同一 admission 边界复核原 pending owner；显式重注册同 verificationId 会撤销旧清理，旧 attempt 退出不能删除新定义与新资产。

CLI 显式清理、自动结案清理与恢复器统一使用原子清理入口，持有 authored 定义锁及 admission 锁直到资产清理和定义注销完成。每次显式注册都生成新的 `authoredVerificationDefinitionRegistrationId`，核对条目携带该标识；自动清理必须在同锁内核对旧条目与当前定义的注册归属，缺失或不符则保留。旧定义首次 materialize 时持久建立当前归属基线，旧结案快照不追认；迁移完成后的读取不重复写入。该标识只证明清理归属，不表示资产内容已版本化。CLI 当前显式清理可以处置旧无标识资产，但执行退出未确认或路径越界时仍保留定义与资产。

结果应用同时核验 attempt、workspace、真实卡片 incarnation、PDV 条目实例、当前定义指纹和可信终结回执，并拒绝覆盖既有结案。跨部署沿原归属链找到最新副本；旧副本不重复勾选。
