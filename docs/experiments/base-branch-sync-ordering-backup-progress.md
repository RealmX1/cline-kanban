# 排序实验：批次备份与当前阶段

任务：f8bd4。更新于 2026-11-03（America/Los_Angeles）。

最新状态：DD679 已合入 local main，部署由用户确认；残留审批问题按用户要求不阻塞继续，DD679 仍排除于实验样本。构建者、独立协调 Task、原 Task 主 Agent 及 Watchdog 的职责以[修订计划](base-branch-sync-ordering-experiment-design.md)为准。独立看板已恢复排除 DD679 后的 12 张卡、工作树和原生历史，bd273 的真实 TUI 已显示原最终交付记录并待命；专用文字 Task 的普通 CLI 消息已得到原生唯一接受与回复证据。正常 hooks 已启用，私有 origin 已建立且实际 fetch 通过；尚未执行样本合入。最终 main 种子按用户要求等本任务提交并交回 main 后再制作，各轮使用第二级可写实例。以下早期阶段与数量均保留为历史记录。

当前处于**独立看板构建收尾**，范围冻结：只完成必要验收、按实际增量复用评审、提交及 base-branch-sync，然后制作最终两级种子并交给独立协调 Task。下文旧的 R1 排序准备及三任务先行试跑是历史阶段，不是当前执行路线；不再增加中央整合控制器、预算框架或泛用投递功能。

控制通道目前保留普通原生 RPC，按会话放行精确 socket，而非 `--no-daemon`。文字核验中即时回执失败、稍后接受补证成功，初始失败历史不删除；协调者须核对原生接受与回复后再决定是否重发。专用核验 Task 不计入样本或正式对照次数。

本次扩展只读筛查确认新增 5 张可能待合入卡：4b154、5913b、5ab53、982d3、69810，连同原有 12 张共 17 张。新增工作状态、原生历史和评审原件已保存；其中除 5913b 外的 4 张均有完成的精确 RVF，冻结完整树与被测树一致。5913b 仍为 unknown，不解释为失败，正式去重及准入另记。实时列表查询超时，盘点使用持久看板与实际 Git 状态交叉核验，降级原件已保存。

用户最新明确：本会话是设立者与 Overwatch；先验收现有交付、提交同步，再备份状态数据，最后由独立 Task 开启真实看板首轮。Sync Orchestrator 严格逐项派发，完成并验收一个后才开始下一个；独立看板和对照环境进一步实现／完整验收延后。

## 数量口径

原需求时间窗保持锚定，不向后滚动。初筛共 19 张卡：10 张仍有 WIP，另外 9 张无 WIP 且 HEAD 已包含在固定 base 中，逐张排除依据已经落盘。d55ee 未作为采集目标，也没有读取其 worktree 或原生会话。

最初优先完成的 bd273、42534、dd679 是三项先行备份，不是候选总数。用户纠正后，本轮优先补齐整个原范围，再继续实验。

| 已备份任务 | 交付覆盖与资格说明 |
| --- | --- |
| bd273、42534、dd679 | 当前完整树与各自精确 RVF 验证树一致 |
| 11d06 | 原 run 后来已完成；当前恢复树与最终交付的完整验证树一致 |
| 63ecd | 保存原 RVF、主审补修及后续清理记录；当前候选资格另核验 |
| 82e07 | 保存实际取消／未完成记录，不能将备份成功当作 RVF 完成 |
| 4e935 | 保存交付与证据，独立评审覆盖另核验 |
| 53335 | 保存父任务整包及原始整包审阅记录 |
| 9507b、2c007 | 保留各自原始状态；交付已被 53335 接收，实验入组时不能重复计入 |

因此，**10 个任务状态备份**、**去重后的独立实验单元**和**精确评审资格已核验的输入**是三个不同数量。不能据此把任何一组擅自改成“三个候选”。

## 持久入口与内容

完整备份根目录：

```text
/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/f8bd4/base-branch-sync-ordering-experiment-implementation/reusable-original-cohort-backup-20261103T0445Z
```

- `reusable-cohort-backup-manifest.json`：来源、固定 base、10 项任务、对象包及附件索引。
- `workspace-state-at-capture/`：看板、会话、Prompts、投递、停止观察、执行记录等工作区 JSON。
- `tasks/<taskId>/`：HEAD、原始 index／split index、staged／unstaged／untracked、删除、权限、链接、独立 Git 对象包、原生转录及完整边界证据、计划／评审／交付附件和配置层。
- `base-working-state/`：base 工作区原始 WIP 和 index；实验 base 的固定 commit 单独记录。
- `execution-environment/`：三项目安装状态、任务私有覆盖、精确依赖、运行发行物及 Node／Codex／Git 等二进制。相同依赖内容复用归档对象，物化时复制为独立文件。
- `cohort-supplemental-evidence-manifest.json`：托管命令原始日志与补充工作流代码，保留取消与失败。
- `scoped-task-relation-ledger-read-only-snapshot.json.gz`：10 项任务相关关系账本的只读审计切片；不用于覆盖生产账本。
- `screened-task-exclusions.json`：其余 9 张初筛卡的排除证据。

原始绝对链接和实际恢复映射分别保留。活体 PID、socket 和控制归属属于当时的观察，不恢复成活进程。原生历史中 9 项有完整最终回合；2c007 的原始历史已完整保存，但最后一回合的完整结束未证，不擅自删掉尾部或冒充可 fork。

## 已执行的验收

在操作系统沙箱中，实际拒绝读取生产 `.git`、任务源码及真实 board，并禁止网络；使用归档的 Node 和独立打包的恢复器完成：

- 10 项任务与 base 的独立恢复；共核对 26,121 个任务路径的内容、类型、模式及原始 index。
- 117,926 个归档文件条目的哈希／链接校验。
- 28 个依赖／发行安装快照的私有物化；4,124 个链接均映射到私有目录，没有可写硬链接连接生产或归档模板。
- 对原任务及 base 再次执行 WIP／index 核验，并逐项比较原生转录哈希，10 项均保持不变。

原件为 `production-read-denial-probe.json`、`cohort-backup-integrity-and-offline-restoration-verification.json`、`offline-verification-process-result-after-link-closure.json`、`offline-restoration-validation/private-execution-environment/private-environment-restoration-verification.json` 及 `production-source-preservation-verification.json`。

最初阶段的 12 项 guarded 测试和专用 TypeScript 检查通过，覆盖未知提交对账、迟到 Token 补证、预算准入和并发防重复；根项目全量 typecheck 曾因既有 exploration 包接口不匹配失败，未修改共享依赖或降级源码。当时尚未执行产品构建、全量产品测试或付费 RVF；后续评审与用量见下方追加记录。

历史备份验收时的“实验模型回合未启动”只指当时脚手架没有发送原生 `turn/start`。排序阶段新增回合按其持久原生记录另行计量。本主会话的开发、调查及备份工作本身消耗了 Agent Token，属于公共准备成本；目前尚未自动归集，不能将本阶段总 Token 或总费用写为零。

## 下一阶段

用户已明确选择：三任务预实验完全隔离，第一个完整实验才在现有使用环境实际合入，并采用先验分析更有希望的顺序；完整实验的 FIFO／其他顺序从相同新起点的冻结副本做对照。先核验排序理由、共同依赖与验证清单，再执行完整实验的本地同步。该选择不抹掉源任务明确的 Stop 或未通过的质量门禁，也不授权 push base、部署或移入 Done。

本备份是逐任务、逐文件校验的一组逻辑快照，包含各自采集时间；不是全机内存／原子系统镜像。相关 OS 与架构仍属于执行环境条件。

## 开始前的仓库状态快照

用户补充要求“repo的当前状态在开始前也要妥善备份”后，已另行完成：

```text
/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/f8bd4/base-branch-sync-ordering-experiment-implementation/current-repository-before-live-experiment-attempt-001
```

`current-repository-state-backup-manifest.json` 的状态为 `current-repository-state-backed-up-and-restored`。保存 3,063 个 refs、4,004 个 refs／登记 worktree HEAD 对象起点及对象包，另存 Git 管理状态、主工作区和 f8bd4 的原始 index 与完整 WIP。独立 bare mirror 已逐 ref 核对并检查全部对象起点；两份工作区也已恢复校验。采集期间源 refs 和工作状态未改变。

此时本地 base 为 `8bba9e0f86b433fabea4526b6b4f6b6603d099bf`，已从总备份时的 `2dc9fe83a225a72bf764ce1799d10a4bb36a9c24` 前移，10 个原候选的 WIP 均未变化。因此派生批次 `ordering-preexperiment-preparation/exact-reviewed-batch-attempt-003` 同时绑定原候选对象包与新仓库对象包，真实首轮和离线对照共用新 base。旧基线的两次派生尝试保留历史，不用于本轮真实首轮的对照起点。

当时可核对到完整 RVF 候选／最终验证树与冻结 WIP 一致的有 bd273、42534、dd679、11d06。后续补证明确：63ecd 相对正式评审后有 29 文件实质增量，不能只报告末次主审验证后的两处配置差异；82e07 原执行明确取消，4e935 当时按风险不发起新 RVF；53335 的父整包独立终审与冻结内容精确匹配，归档中的正式失败实际属于子 9507b。两个被父任务接收的子交付保留备份，不重复入组。

新排序会话只能读取该组冻结资料。开始前已实测生产路径读取和本地 Kanban 连接被拒，TLS 模型端点返回未认证的 HTTP 401，证明网络可达但不证明模型推理或鉴权成功。首次接通发现原生空线程在首条用户消息前可能尚未落盘；宿主提前退出后不能按该 ID resume。失败握手未发起用户回合，已留证，并改为由同一宿主持有线程创建与首条用户回合；任何可能已提交的记录仍只能对账，不能创建替代回合。

## 排序接通的恢复记录

首个排序回合已按原生记录核对为 interrupted；协议恢复尝试在 workspace routing discovery 失败，二者计量均为 unknown，未得到可采用顺序。第二次尝试没有被覆盖。

无推理诊断随后定位到：Codex 原生 HTTP 客户端会自动读取 macOS 系统代理 127.0.0.1:7897，该回环端口被实验沙箱正确拒绝；curl 直接 TLS 可达并不能证明原生客户端采用相同路线。私有环境固定 `NO_PROXY=*`／`no_proxy=*` 后，原生模型目录在线获取成功，缓存 fetched_at=2026-11-03T07:35:36.426768Z，10 个模型；本地代理和 Kanban 端口仍未开放。原件位于派生批次的 `native-model-discovery-diagnostics/`。

当时依据这项机器证据，Agent 增加一个命名固定的 `verified-network-recovery` 恢复入口，并自行设置总分析回合最多三次。这个历史边界不是用户预算。旧入口仍核对上一失败完成状态与原生目录缓存哈希，旧台账不改写；后续成本政策已修正为默认无 Agent 自定总上限。前两次计量缺失继续保留 unknown，该恢复不增加正式对照重复数。

原归档的 Codex 主程序未包含配套宿主，因此在持久实现根的 `supplemental-codex-native-runtime-closure-0.166.0/` 另存 Codex 与 codex-code-mode-host，主程序哈希与原备份一致；原总备份未改写。真实恢复器的原始成功只证明 Git/依赖及原生历史可恢复，不证明当时已具备成功推理闭包，不能将这两项验收混为一谈。

## 用户澄清后的阶段边界与 main 再次前移

三任务预实验固定在隔离副本，不得提交源 Task、推进 local main 或续接真实源会话。它用于恢复、计量、验修成本校准，不能消耗第一个真实完整实验的起点。之前“真实环境预实验”的表述已撤回；真实使用环境授权只用于第一个完整实验中更有希望的顺序。

在用户告知 main 再次前移后，已另存并验收 `current-repository-after-main-advance-attempt-002/`：固定 base 为 `feeaa8f346caad1d3ae461ab07cd0157f7edbf9e`，保存并还原核对 3,078 个 refs、主工作区及本任务的完整 WIP/index，10 个原候选均未漂移。旧快照和旧派生批次保持原样。完整实验尚未开始，其最终 base 在开始前重新冻结，不能把这份活环境中的阶段快照写成最终开始点。

网络恢复后的第三个排序回合已 completed，记录 input=66,473、cached input=51,840、output=2,029（reasoning 属于 output）。但 Agent 的命令工具被嵌套 sandbox-exec 的 sandbox_apply 拒绝，未成功读取冻结资料，返回空 order／空 evidence。严格结果 schema 已拒绝该结果，所以没有可采用顺序。前两次计量继续 unknown；这些尝试属于准备／恢复成本，不能当作排序收益或成功预实验。需恢复并自动验证真实 Agent 工具的只读读取能力，再在后续明确预算内执行排序。

本任务脚手架已启动固定基线双审，精确目录为 `f8bd4-experiment-scaffolding-snapshot-review/run`；独立发现和本次真人澄清保存在同级 `main-agent-independent-findings.json`，收到匿名发现通知后按精确 run 补充，不重开已有 run。目前没有执行任何候选的生产提交、base-branch-sync、push、部署或移列。

## 原脚手架验收与新增量准备

原双审已收口：两席完成、8 项发现修复、最终两条验证命令通过；固定候选为 `7e0d20fcc6c6b7c815768df30856c3af5536e016`，完整被测树为 `91c80744aa63034bcc901ac248727fa2c31d7010`。状态为 `ready_to_commit`，本任务没有普通提交。新增受限 integration/fork、suffix 恢复、依赖闭包和成本政策改动另作差分 RVF，不能称为已被旧 run 覆盖。

10 个 Task 去重后是 8 项独立交付：9507b、2c007 已并入父 53335。新版历史资格记录接受四项精确 RVF 匹配，并将 53335 的等价独立终审用于下一批次准备；其余三项保留具体覆盖缺口。该决定不扩充已冻结三任务样本，也不直接签发新 main 上的执行资格。

两组私有依赖已恢复并挂接，八份 worktree 的 HEAD、原始 index、完整 tracked 差异及 untracked 内容保持冻结状态。实际只读预检发现 Apple Git 的 diff 可刷新 index stat，已核对仅缓存字段变化并按 SHA/CAS 恢复原字节，后续显式关闭 `diff.autoRefreshIndex`。Node、SQLite、tsx 与 TypeScript 的轻量预检通过；完整依赖树验收、正常 hooks 及任务组合验收仍待控制器执行。

用量须分层报告。`latest-observed-preparation-and-calibration-token-cost-lower-bound-v2.json` 记录的已知下界为 30,558,828 个输入加输出 Token，其中 28,789,888 为已包含的缓存输入；这是共用 RVF 准备和实验校准的观察值，仍缺部分失败、主会话和平台分身成本。934,321 仅是已知校准／排序部分，不是区间或整个实验总量，亦不是停机阈值。

三次排序均没有可采用结果。此前“大改动优先”是尚未执行的提案，已恢复为先取得有效语义排序再决定相对顺序；其历史记录不删除。三任务实际合入尚未开始，第一个完整真实实验的起点仍须在实际开始前重新备份冻结。

## 最新 main 与新增任务的备份版本

再次核对 local main 为 `016295194ebb47356d1231751b5b77f8ca520b6f`。仓库快照 `current-repository-after-checkpoint-ref-settled-attempt-004` 已保存并还原核对 3,108 个 refs、4,062 个对象起点、main 与本任务的原始 index 和 WIP。前一次 attempt-003 因额外 checkpoint ref 在采集期间出现而未通过严格稳定性检查，失败原件保留；它不被计为成功备份。

新检索到的近期 Review 卡中，4b2dc、c4237、94d4e 仍有待合入实现；另十项当前没有待合入实现内容或只剩浏览器观察产物，不据此推断其工作流均已完成。新增三项连同原十项已保存为 `reusable-original-ten-plus-three-new-tasks-cohort-backup-attempt-001`，共13个 Task、去重后11项独立交付。原有快照与隔离三任务样本保持不变，d55ee继续排除。

新版总备份已验收：隔离进程禁止生产源码读取和网络，恢复 base 与13项Task，核验114,058项归档条目和34,019个任务源码路径及原始index。33个私有安装目录、5,147条依赖链接均已恢复映射，无生产可写硬链接。保存的可执行闭包包含Codex及配套code-mode-host。归档含各自时间和来源，不称为原子全机镜像；新增Task运行时关系账本查询暂不可用，冻结卡片及会话归属已保存，该关系补充保留unknown。

三项新增任务的原始双审均为 `ready_to_commit`，最终验证分别8/8、6/6、3/3通过，被测完整树与此次冻结树相同。它们的历史精确覆盖不代替新base上的组合验收。原有63ecd、82e07、4e935的覆盖缺口继续保留，53335的等价独立终审与正式RVF未知状态继续分别记载。

排序恢复增量已实现默认无自加总额度、旧预算及prompt幂等接续、精确评审工具链核验和同宿主无推理预检；新增局部guarded验证14/14通过，完整增量RVF尚待执行，不能写为已完成。备份更新不表示真实完整实验已经开始。

## DD679 合入后的仓库校准快照

当前 local main 为 `0ee4e5d361d5298d530c7928f0a6632ce4e57c62`。新增并独立恢复验收的备份为持久实现根下 `current-repository-after-dd679-worktree-state-settled-attempt-006`，保存3,147个 refs、全部登记 HEAD 对象闭包、Git 管理状态、主工作区和 f8bd4 的 WIP／原始 index；源 refs 和工作状态在通过的采集过程中保持不变。原13项归档中除 DD679 外的12个 Task 工作状态仍与原备份一致；DD679 的当前变化另存，不重新加入样本。

attempt-005 因采集期间新增一份结案恢复核验 worktree 而未通过稳定性检查，main 和 refs 本身未变；该失败版本与证据保留。attempt-006 按新的稳定状态重采并通过。

这份快照是构建落地前的校准点，不能标记为正式实验已经开始。正式共同起点在本构建 commit／base-branch-sync 之后另行冻结，同时补齐当时的看板、会话、配置、依赖及已部署 runtime 发行物备份。各隔离轮次使用独立可操作 runtime，从该共同起点恢复。
