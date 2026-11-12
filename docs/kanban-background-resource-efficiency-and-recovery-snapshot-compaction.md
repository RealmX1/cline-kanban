# 后台资源效率与恢复快照压缩

## 批准范围与实现合同

任务 `72ba2` 的资源调查方案已由用户“plan approved. read it and start.”批准实施（PLAN-READY）。目标是降低配置恢复和插件诊断的重复工作、限制终态恢复快照正文增长，并使广播诊断反映实际提交的应用帧。

涉及配置同步服务与既有 SQLite lookup、插件快照扫描器、关系账本 worker/client、广播 hub/记录器及其测试。每日进展采集、Token 去重状态、命令监管和 RVF 的相邻研究不在本轮修复范围。生产重启、部署、同步、提交与推送没有包含在此批准中。

用户另要求子代理核对 `926b2`。已只读检查其设计基线、真实研究试用授权和完成交接；该任务负责 Software Factory 与跨 Task 文档权威研究，未发现四项重叠，故没有移交性能实现责任。对照依据位于 `~/.cline/kanban/task-cross-task-handoff-artifacts/926b2/plan/software-factory-design-baseline.md` 和 `real-research-pilot-20261112/`。

## 已核验的起点

2026-11-12 00:29 PST，绑定原生启动世代的 PID 58528 最近五分钟平均约 192% CPU、RSS 3.67 GiB、主线程 heap 0.61 GiB。54 小时记录中存在明显内存回落，尚未证明持续内存泄漏。部署记录为 `93805f6c`，本任务起点 `7f9f4b8f`；调查涉及的关键模块通过 sourcemap／文件内容核对与运行构建一致。

配置活跃投影约 19.6 MB，一轮有 3,836 个目标，其中 3,280 个关联退休 writer。隔离只读实验中，8 次整读／复制／序列化约 2.40 CPU 秒，已有定向 lookup 约 0.08 秒；这证明局部成本差异，不是生产总 CPU 的归因比例。

插件扫描 4,000 个条目时反复 `Object.keys`，累计枚举约 1,601 万个键，单次约 1.1 CPU 秒。关系库中 7,493 个终态批次保留约 3.06 GB 正文；这属于磁盘增长，不能称作内存泄漏。广播 v1 的发送字节按转换前完整候选载荷计量，不能作为网络流量证据。

## 实现与不变条件

- 配置恢复先用本轮快照筛掉没有可续接会话的目标，再用 `lookup` 精确读取变更、目标 writer 及来源依赖；后续启动采用的局部提交也按目标和替代 writer 读取。原生请求归属诊断只读取已知 writer，不再把无关活跃 writer 带进恢复调用链。局部提交保留 storage generation、来源/profile 版本、当前代际、Stop、草稿／待答和原生提交阶段门禁。退休 writer 的后续启动采用仍保留；不能单凭 retired 状态跳过。
- 插件扫描以递增计数检查条目预算，保留原有条目顺序、4,000 条目、深度 16、单文件 2 MiB、总摘要 8 MiB、软链和读取中变化语义；不延长五秒扫描周期。
- 终态正文清除与事件结算、当前快照投影共用同一 SQLite 事务。`pending` 的正文完整保留；批次身份、哈希、revision、状态、时间、全部账本事件、字段正文和幂等凭据不删除。旧运行时仍只解析 pending 正文，因此无需改变 schema version。
- 历史维护每轮最多 32 条／4 MiB，每秒让出 worker；单条超预算时仍须原子处理该条。尺寸与非空筛选均用 `octet_length` 读取字节长度元数据，避免预算判断前加载完整正文；正文不传入 JS 或 IPC。已清空正文是持久进度，重启幂等接续。空轮后每分钟从头补扫，覆盖旧版本稍后结算的低 rowid 批次。写锁不等待；前三次退避，随后每分钟健康重验，成功后恢复正常批次。只暂停维护，不阻止业务请求。
- 历史维护进度经有界轮转 journal `terminal-board-mutation-snapshot-compaction` 记录完成量、重验条件及下一次尝试时间。没有自动 `VACUUM`；清除正文释放页内空间供 SQLite 复用，不承诺数据库文件立即变小。
- 广播采用诊断 schema v2，区分候选序列化字节、实际提交的压缩前应用载荷字节、逐连接去重跳过。HTTP／WebSocket 业务契约不变；v1 历史日志原样保留，详见[广播刻度](runtime-state-broadcast-cost-measurement.md)。

## 验收

每项先以失败回归证明退化，再实现并跑同一回归。配置恢复检查无动作目标增长时完整读取次数保持常数，以及实际目标采用、权限收紧、版本竞争、草稿与 Stop、原生回执丢失和跨代恢复。插件扫描检查 1,000／4,000 条目和覆盖缺口等价。关系库注入事务投影失败，验证正文／状态／序号一起回滚，重复提交不重放；历史维护覆盖分批、重启和暂时故障自动恢复。广播在真实 hub 中核对 v2 差量、无基线版本通知和去重次数／字节。

性能对照使用固定合成工作量、隔离 HOME/CODEX_HOME、串行五组 AB／BA，分别记录 CPU 秒、解码量、序列化载荷与事件延迟，不将嵌套墙钟相加冒充 CPU。浏览器／终端长时观察只用隔离实例；真实部署后的资源变化另注册自动验证定义，不用测试实例结果冒充生产通过。

## 自动化验证与交付记录

验证使用任务独立的 `node_modules`、`dist`、`web-ui/dist`，未改主仓库共享依赖或产物。原共享依赖的 Node ABI 已漂移，任务内重新构建 `better-sqlite3` 后以 Node 22.22.3 验证；没有在主仓库重建原生包。

- 25 个相关文件的 232 项 guarded 回归通过，含首次失败再转绿的规模、权限、并发和恢复用例。最初一次 230 项断言通过但因同时编辑测试文件触发 canary，未计为整体通过，随后已冻结编辑重新验证。
- 真实 Chromium 终端回归 11 项、Web UI 终端单测 94 项通过，覆盖单通道断线、全屏恢复、隐藏页、迟到输出、不同尺寸 viewer、切卡焦点和 LRU 生命周期。
- 五组 AB／BA 的扫描快照（含特殊文件名）逐字等价；配置查询固定一个有效目标，把其他 writer／pending 目标由 20 扩至 200，定向解码量保持稳定。原始记录与冻结基线保存在任务持久目录 `~/.cline/kanban/task-cross-task-handoff-artifacts/72ba2/implementation-verification/`。
- 30 分钟观察运行在冻结派生工作树 `cline-kanban-resource-observation-frozen`，每 30 秒变更一张合成卡，按五分钟周期切换 1／4 个真实状态流客户端。它覆盖修改后的主循环；收尾补充的特殊文件名、请求归属定向读取、旧版本补扫和转换失败分账另由对应回归与最终打包态短观察覆盖。不能把该观察冒充包含真实 agent 转录的生产负载。观察结束后已核对源码／产物哈希并保存完整冻结快照，回收派生工作树。

最终源码的根项目、Web UI 类型检查及隔离构建通过。额外一轮 guarded 验证为 9 文件、55 项通过、1 项默认跳过，覆盖真实运行时状态流、账本捕获、真实 PTY 洪水回显、最终打包态 90 秒观察及 CPU 对照；跳过的是已有的完整“系统概况”浏览器场景，本轮终端浏览器 11 项另行运行。变更文件 Biome 检查无错误，保留 `runtime-state-hub.ts` 原有的 non-null assertion 警告；worker `node --check`、`git diff --check` 通过。没有运行全仓所有测试。

五组 AB／BA 最终结果（Node 22.22.3，数值为 CPU 时间中位数）：

| 固定工作量 | 原路径 | 修改后路径 | 限定 |
| --- | --- | --- | --- |
| 4,000 条目插件快照 | 1,163.9 ms | 494.0 ms | 快照逐字相同，约减少 58% CPU；空文件合成语料 |
| 20 个待处理目标，8 次投影读取与复制 | 23.7 ms | 3.0 ms | 有效目标固定为一个，其他 writer 携带 32 KiB 合成字段 |
| 200 个待处理目标，8 次投影读取与复制 | 211.6 ms | 1.7 ms | 解码量约 57.46 MB → 51.18 KB；不是生产整体 CPU 比例 |

定向读取在 20／200 目标规模下分别解码 51,168／51,184 字节，8 次投影的 V8 序列化大小分别为 44,296／44,328 字节。这里记录的是逻辑解码量和复制载荷，不是物理磁盘读写或网络流量。进程 CPU 包含数据库 worker，不包含浏览器进程；复制载荷计量自身也计入实验时间。

30 分钟观察完成 60 个固定工作量周期、收到 919 个状态流帧，guarded/canary 通过；RSS 采样约 322–373 MiB，heap 的七个原生采样约 193–207 MiB，并有回落。59 个事件循环窗口的 p99 中位数为 23 ms、最高 p99 为 24.3 ms，单次最大延迟 39.6 ms；这不是键盘端到端延迟，也不能与不同工作量的生产窗口直接比较。最终打包态额外 90 秒观察及两份验证脚本的正向隔离检查也通过，未把检查写成生产验证通过。

所有隔离运行时已退出。生产 JS profile、大规模真实 agent 转录／原生会话负载下的持续内存归因，以及实际部署后的 CPU 收益仍待真实实例验证。数据库正文释放供 SQLite 复用，数据库文件不会自动缩小。本轮没有提交、同步、推送或部署，未修改真实运行代码或配置，也未停止／重启真实运行进程；仅按要求登记任务元数据、范围核对关系和验证定义。

有界实验可通过以下 guarded 入口复跑（环境变量路径均须指向持久目录；默认测试不会自动跑长观察）：

```sh
KANBAN_RESOURCE_SOAK_DURATION_MS=1800000 \
KANBAN_RESOURCE_SOAK_EVIDENCE_DIRECTORY=/持久证据目录 \
npm run test:guarded -- --project runtime-integration \
  test/integration/kanban-background-resource-fixed-workload-soak.integration.test.ts

KANBAN_BACKGROUND_RESOURCE_COMPARISON_EVIDENCE_DIRECTORY=/持久证据目录 \
KANBAN_BACKGROUND_RESOURCE_BASELINE_SCANNER_SOURCE_PATH=/冻结基线源码.ts \
npm run test:guarded -- --project runtime-integration \
  test/integration/kanban-background-resource-cpu-comparison.integration.test.ts
```

## 部署后验证定义

| 行为 | 部署前已证 | 真实实例待验 | 类型 |
| --- | --- | --- | --- |
| 配置恢复与插件扫描 | 规模、内容等价、并发门禁与原生模拟回归 | 实际生产 CPU 收益仍须按工作量对照，不能从合成语料直接外推 | 不注册没有稳定判据的指标项 |
| 终态正文回收 | SQLite 原子性、pending 保留、幂等、重启、临时故障与旧版本补扫 | 部署进程实际加载维护 worker，进度完成或持续符合每轮预算 | `automated_script` |
| 广播 v2 刻度 | 真实 hub 的差量、去重、转换失败与恢复路径 | 当前监听进程确实输出 v2，已发送帧与去重分账有效 | `automated_script` |

已为任务注册以下定义，均使用独立持久资产目录，清理模式 `automatic`。旧实例 dry-run 均以明确原因返回 1，未崩溃、超时或创建业务实体；未执行部署后通过登记。

| verificationId | 标签 | assetsDir |
| --- | --- | --- |
| `a311f440-c6c9-41af-8655-f91d240bb3d7` | 当前运行实例使用 v2 广播刻度，真实应用帧提交与去重次数分别记录 | `~/.cline/kanban/verifications/a311f440-c6c9-41af-8655-f91d240bb3d7/` |
| `78ddb2c9-d8f2-43f6-b522-fc30b1e3a47b` | 当前运行实例的终态快照维护已完成空轮或正在预算内自动推进 | `~/.cline/kanban/verifications/78ddb2c9-d8f2-43f6-b522-fc30b1e3a47b/` |

`verification list` 自查为 2 条 automated、0 条 guided；部署 record 后预计挂载这 2 条。脚本按监听端口、进程启动世代绑定 journal，仅读每个轮转分片尾部，不读配置正文或直接改业务状态。异常或缺证非零退出；没有把历史进度当作当前运行事实。

兜底清理：

```sh
kanban verification cleanup --verification-id a311f440-c6c9-41af-8655-f91d240bb3d7
kanban verification cleanup --verification-id 78ddb2c9-d8f2-43f6-b522-fc30b1e3a47b
```

无临时 repo instrumentation，不需要移除源码探针。具体注册和旧实例 dry-run 回执保存在任务持久目录 `post-deploy-verification-authoring/registration-and-old-instance-dry-run.json`。
