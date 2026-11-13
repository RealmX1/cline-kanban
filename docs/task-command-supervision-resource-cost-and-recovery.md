# 命令执行监管的资源成本与恢复

本任务 `89b54` 的调查基线为 `7f9f4b8f7d8ecf89c67b8188ccb19a612c3e114c`。用户于本会话批准方案后，实施范围扩展到共享监管、观察、持久化和取消补证；不包含 RVF 工作流修复、提交、同步、部署或真实进程处置。

## 可复核证据

原执行 `96197f63-4b25-4b73-86ef-bd96d7ae5dc7`、nonce `8c8b5ef4-a759-4571-adce-0734896ff0c0` 的冻结脚本、启动材料、进度和日志保存在来源任务的持久证据目录：

`/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/my-device-setup/task-3357f-resource-efficiency-research/source-evidence`

12 份快照 SHA-256 均已核对。冻结监管脚本 SHA-256 为 `0720798c3590c11f139ad9c15f2eb538beeec71d83fa32962e8a1e46d5de5355`，与调查开始时本工作树及本地 main 的生成脚本相同。原 PID 64160 的启动世代为 `2026-11-12T06:04:01Z`，不能只凭 PID 回溯归属。

原生轨迹 `task-attributed-process-lifetime-episode.1.jsonl:5340` 记录该世代累计约 1,212 CPU 秒、峰值 footprint 1,169,162,240 字节。该行包含换行的 SHA-256 为 `7290751ed8181a86f91d7d7577baffd149a868846f9643e77de3b318943a1f55`。来源现场及这些历史证据不能冒充当前仍在发生的异常：绑定进度已经 `exited`，最后一次调查核对时原监管器及三个开发服务进程均不存在。

| 发现 | 独立核验 | 结论 |
| --- | --- | --- |
| 历史身份扫描放大 | 1,582 条身份逐 PID 重放产生 1,582 次 ps、4.84 秒墙钟、约 4.02 CPU 秒；同批身份一次完整命令行快照约 56ms | 已确认；不是严格 5Hz 的循环，因为同步查询也占用循环时间 |
| PDV 无界定向查询 | 即使主动预算耗尽，隔离源码执行仍同时发起 1,583 个查询 | 已确认路径，未量化生产峰值贡献 |
| 重复账本读写 | 65 条稳定夹具一轮读取整表 261 次、写入 65 次 | 已确认；研究阶段使用内存存储，没有执行真实磁盘写入 |
| 未完成 Promise 累计保留 | 同一 completion 的 15 万次 race 在强制 GC 后保留约 44.7 MiB，完成后释放 | 已确认存活期间保留；不等同于证明历史 GiB 占用成因 |
| 一次性取消补查 | `rechecked=true` 后，证据恢复仍不再补证 | 已确认恢复缺口，不代表原现场当前仍有残留 |

Node 22、Node 24 的短程逐 PID 重放未复现 GiB 常驻占用。历史高内存的完整成因，以及主服务自身高 CPU 的全部来源仍未知。

## 实现与身份边界

- 独立监管器复用每轮进程快照，只导出 PID、父 PID、状态和启动时刻。历史身份继续保留，已退出或 PID 已复用的世代不进入活体信号候选；僵尸不阻塞结束。发信号前再次定向核验代际。
- runtime inspect、取消和 PDV 的只读观察复用批量身份观察。必要定向查询使用现有 `p-limit`，最多八路；Linux 环境归属读取同样有并发上限。原生代际缺证保持未知，不降级为秒级身份授权。
- Darwin 的 `snapshotComplete` 汇总所有系统 PID 的原生精度，不能作为“PID 枚举失败”的全局门禁。逐行处理归属与缺证，不因系统整体标志阻止派发；无法关联的当前 PID 仍保留归属未知。
- 正文运行期保持 200ms 观察；正文完成但仍有已知后代时使用 1 秒观察。取消、超时及单纯等待缺证时仍每 200ms 检查控制条件，昂贵缺证观察以 15 秒为窗口。
- 稳定进度不重复 durable 写盘；`updatedAtEpochMs` 表示最后一次内容变化，不能作为进程死亡心跳。派发屏障、撤销、恢复预算及终结原件继续立即持久化。
- 账本的解析缓存只用于候选筛选与只读观察。实际派发、取消、投递以及持锁变更仍权威重读；内容不变时不刷新时间戳、不写整表。旧调用方原地修改数组的存储契约保留。
- 等待循环只保留一个 completion 回调，不重复向未完成 Promise 挂载 race。
- 取消补查在锁内持久领取资格，同一证据最多三次、间隔 15 秒；耗尽后继续轻量观察，证据变化自动恢复。预算和撤销跨重启保留，迟到补查不能覆盖新资格。
- 生产方 `cancelCommand` 派发前持久化独立屏障。恢复只补原生进程回收；保留旧观察的兼容语义，不因旧 `rechecked` 永久停机，也不重派业务命令或重复执行生产方取消。

## 资源与回归验收

第一版批量实现的 60 秒夹具仍消耗约 11.13 CPU 秒，超过 6 秒硬档，因此没有作为完成依据。缩减进程列并对正文结束后的等待降频后，同一 1,582 条历史、三个活体后代夹具耗时 60.38 秒、监管器及查询子进程约 1.18 CPU 秒，低于 2 秒软档。150,000 轮等待的强制 GC 保留内存约 218KB，低于 2 MiB 上限。这些是隔离夹具结果，不是部署后整机收益保证。

确定性回归覆盖 0、100、1,582、10,000 条历史身份，每轮 ps≤2、原生 helper≤4，调用数不随历史规模增长；65 条稳定记录在运行中和归属缺证两种状态下，每轮账本解析≤2、写入均为零。其余覆盖 PID 复用、exec、僵尸、reparent、detached 后代、原生精度缺失、连续查询失败后的恢复、并发领取补查、跨服务重建保留预算以及旧结果与迟到回执。

真实子进程测试覆盖正常完成、SIGTERM 后忽略信号并升级 SIGKILL、跨 runtime 继续同一执行、并发只派发一次、监督者失联后的未登记后代回收。计时与 CPU 均遵循 `test/README.md` 的软硬两档规则；Linux subreaper 场景由 Linux CI 执行。

```sh
npm run test:guarded -- --project precommit-safe --maxWorkers=1 test/runtime/task-command-execution test/runtime/deployment/verification
npm run test:guarded -- --project runtime-integration --maxWorkers=1 test/runtime/task-command-execution/owned-command-supervisor-resource-costs.integration.test.ts test/runtime/deployment/verification-execution-runtime-restart.integration.test.ts test/runtime/deployment/verification-execution-linux-kernel-containment.integration.test.ts test/runtime/deployment/verification-script-runner.integration.test.ts
node --expose-gc scripts/task-command-supervision-resource-regression-measurements/measure-pending-command-wait-retained-heap.mjs
python3 -B scripts/task-command-supervision-resource-regression-measurements/measure-stable-supervisor-process-tree-cpu.py
```

脚本夹具自动隔离 HOME/CODEX_HOME/CODEX_SQLITE_HOME，实际进程会自然结束或在 finally 中按世代回收。CPU 夹具只在私有执行中注入合成的已退出历史身份，不修改真实启动材料或任何存量监管器。

最终验证结果：22 个相关单测文件、166 项通过；13 项 PDV 实际执行与跨 runtime 集成、4 项资源/完成/取消/等待内存集成均已通过。macOS 本机跳过两项 Linux 专属 subreaper 验收，仍需 Linux CI 的真实运行结果。根项目和 Web UI 类型检查、隔离构建、打包 CLI `--help` 均通过；全仓 lint 退出 0，有 13 条未修改文件中的既有警告。

同一内存验收脚本对冻结旧入口的最终负对照测得约 58.6 MiB，并按预期超过 2 MiB 上限后非零退出，证明检查能检出原问题。该独立 VM 夹具与早期研究夹具的对象布局不同，不把两者的具体内存量当成生产占用预测。Node 22 原生依赖验证使用任务独立的 `better-sqlite3` 副本，未重编共享依赖；两处构建输出均先移除指向主仓库的软链，且显式设置了 `KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY`。

## 存量兼容、交接与部署后待验

新生成的监管脚本只在后续合法启动生效；存量进程继续使用已经载入的原脚本，不能通过覆盖文件宣称热修复。新 runtime 的 inspect 和取消观察可以处理旧材料与旧字段，不重跑初始命令。没有新增用户配置、CLI 动词或公共执行状态。

本任务负责共享命令监管；`72ba2` 负责应用其它负载，`16f73` 负责 RVF 开发服务与流程侧回收。后者即使修复开发服务清理，也不能替代本任务的扫描放大修复。独立证据、批准方案、实验脚本副本、源码快照及最终验证结果保存在：

`/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/task-89b54-command-supervision-resource-evidence`

| 行为 | 部署前证明 | 真实实例待验 | 类型 |
| --- | --- | --- | --- |
| 批量观察、预算、取消、等待内存及资源上限 | 单元及隔离子进程集成 | 无需重复注册测试已证明的内部行为 | — |
| 正常部署后的新监管器稳定进度去重 | 源码生成器测试已证 | 打包运行实例新启动的监督者实际采用本实现 | automated_script |

已登记 `9cbbfd04-97c6-4a83-bdd6-86c05c488841`，资产位于 runtime 的 `verifications/<id>`，cleanup=automatic。脚本只读检查绑定实例与新监管器的稳定窗口；没有可核验的新执行时非零退出，不能假装通过。旧实例 dry-run 约 0.16 秒，明确返回待验，没有崩溃、超时或残留。部署后预计挂载一条自动项，没有勾选或执行部署后验证。

兜底清理：`kanban verification cleanup --verification-id 9cbbfd04-97c6-4a83-bdd6-86c05c488841`。没有 repo 临时插桩。
