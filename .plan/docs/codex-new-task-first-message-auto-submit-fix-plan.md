# Codex 新任务首条消息自动提交修复计划

更新日期：2026-09-12。任务：`ea84e`。状态：实现及 RVF 修复已完成；最终验证证据见本轮 handoff；未提交、未部署。

## 目标与当前证据

用户确认故障是「文本已填入，但未发送」，需要手动 Enter。目标是新建 Codex 任务后，首条消息完整且仅提交一次，自动开始响应，并保留所选 Plan 模式和权限档位。

真实 Codex 0.154.0 复现确认三个关联缺口：首发曾将粘贴和 CR 合并写入；启动加载期间 `/plan` 可被拒绝，输入框背景动画却让旧确认逻辑误报成功；长文本整体折叠时 `/plan` 会成为普通正文，使首轮落到 Default 模式。最终修复在共享提交入口处理这三处，不新增投递队列或独立重试器。

## 本地 main 增量与计划调整

本次将任务从 `accd0a20032899f980c3324dba29aedf22034817` 快进至 `0461eca855031ca00c7dfe3ac284b97c43625429`，吸收 15 个提交。同步前 task 没有独有提交或 WIP；没有冲突。按用户指定的 local main 取材，本次未刷新远端，未推进 base，未创建提交、推送或部署。

| 已落地变化 | 对本计划的影响 |
| --- | --- |
| `b6e56336`：原生 session ID 续跑寻址 | 新增 `observedAgentNativeConversationSessionResumeAddressing`，优先于 cwd-latest 和建卡播种。修复只改消息提交，不改寻址优先级；验证同 cwd 主会话与 By the way 侧问不串会话。 |
| `f4d674ac`：原生身份 sidecar 与 session map 退役 | 原生身份来自 hook 的 `session_id`。真实验收优先使用此身份定位转录，不能用 cwd 下最新文件推断目标；无需改动 thread graph 或重建 session map。 |
| `671c59e1`：fork 重放启动参数快照 | 快照在真实启动时记录 argv，目前仅覆盖 Claude，Codex 返回 null。首条文本迁移不应改变 model、developer instructions、hooks 配置或该快照的生命周期；不为本修复扩展 Codex fork 快照。 |
| `d77919dd` / `f553cbf7`：thread graph 宿主及 findings | 共享 summary、提示词与 hook 链路新增消费者。保留现有 summary sidecar、facet 和提示词组装，不把启动粘贴回显当成新增会话进展。 |
| `6accac9e`：Web 性能改进 | 不改变 PTY 启动提交路径；本次不需要前端实现。 |

本地 main 未覆盖首发缺口；新增重点是验证「新建任务的历史播种」与「已有会话自身恢复」的区别，以及保持新身份/快照链路。

## 最终实现

1. `deferredStartupPromptText` 只保存原始文本；Codex 与 Kimi 首发复用已有分离写与确认链，删除合并框架和 CR 的旧 helper。
2. Codex 启动从当前镜像视口排除 loading、目录信任与忙碌 UI，不再从滚动历史横幅推断就绪。确认阶段检查最后一个 composer 是否仍有本次文本或长粘贴占位符，忽略背景粒子及其覆盖的空格；残留文本不能凭重绘获判成功。
3. 忙碌阶段只等待，补发仍限三次裸 CR、不重贴正文。首发复用 60 秒就绪预算，后续普通程序化投递仍用原有 15 秒确认预算。异步读屏后复查 incarnation 与代际；人类输入、模态待答和退出会清理确认链。
4. Codex `/plan ` 前缀和正文用两个相邻的 bracketed-paste 框架写入；前缀不进入长文本折叠占位符，原生 slash parser 能设置 Plan 模式并完整展开正文。
5. 已有会话恢复时抑制首发文本及残留 `/plan`；新任务从历史 resume/fork 播种仍保留本次新文本。权限参数、原生 ID 寻址、fork 快照契约均保持原有路径。

## 验证与验收

- **先红后绿的启动回归**：fake PTY 模拟合并粘贴＋CR 会吞掉 CR；旧实现不开始处理，新实现仅在单独 CR 后接受一次。不能只断言写过整串内容。
- **时序和清理**：摄入延迟、无回显上限、首次 CR 被吞后有界补发、重复就绪信号不重复粘贴、退出/重启后旧确认链不再写入；用户介入或模态待答时不可由自动补发误提交。
- **启动矩阵**：普通 Codex argv 首发；Plan 首发（中文多行、长文本、无正文）；有 workspace hooks 的真实 adapter 分支；Kimi 首发及恢复。模式与权限保持正交。
- **新增兼容性**：从历史 resume/fork 播种的新任务仍提交新文本；按观察到的 session ID 恢复只接回自身；同 cwd 多会话不串线；回收恢复携带旧 Plan 标记时不触发额外 `/plan`；身份 sidecar、fork 参数快照和恢复输出时间戳守卫不被覆盖。
- **运行检查**：经 `npm run test:guarded -- --project precommit-safe` 运行相关测试，根与 Web 类型检查，并回归后续消息/断线续跑提交。使用现有框架，不另造测试基础设施。
- **真实端到端**：在隔离实例自动启动本机真实 Codex，发送无副作用的验收 prompt。按该会话的原生 ID 检查转录，仅出现一次目标用户消息且开始响应才算通过；不以输入框出现文本、flush 日志或 running 摘要代替成功。隔离 HOME/状态与测试任务，结束时清理。
- **部署后**：实现收尾调用 `cline-kanban-post-deploy-verification-authoring`，注册真实运行实例首发验证，优先自动脚本。已注册自动验证，尚未部署。

### 本次已完成的基线检查

同步并释放锁后，经 `test:guarded`（含安全策略与 invoking-repository canary）运行以下五个既有测试文件：`agent-session-adapters`、`session-manager-auto-restart`、`session-manager-resume-addressing`、`session-manager-task-chat-input-delivery`、`agent-session-fork-replay-launch-arguments-capture`。结果：**5 个文件、166 个测试全部通过，退出码 0**。未运行修复回归或真实 Codex 验收；本次没有业务代码改动。

## 同仓任务与同步记录

调查来自 Kanban CLI，共 215 个 sibling task，无降级、无活跃硬碰撞。以下软重叠均未合入本任务：

| Task | 列 | 重叠区域 | 本计划边界 |
| --- | --- | --- | --- |
| `24508` | review | session manager，消息排队 | 只改启动提交，保留排队与回执逻辑。 |
| `6d284` | validation | adapter / session manager，TUI 渲染 | 保留 alt-screen、协议过滤与镜像行为。 |
| `c269f` | review | adapter，Kimi | 只迁移共享延迟文本表示与提交路径。 |
| `cd144` | review | session manager，终端恢复/连接中断 | 复用确认函数，保留其调用方与恢复判据。 |
| `f75af` | review | adapter，Codex 模型配置 | 保留 argv、模型和 hooks 配置。 |

实现开始前再检查 base 和活跃任务是否变化；当前没有需要用户裁决的碰撞。

```text
DRAFTED_PLAN_LOCATION=本会话前一版计划；修订版为本文件
MUTATION_ALLOWED=1（本地同步与计划文档）
BASE_TIP_AT_INSPECT=0461eca855031ca00c7dfe3ac284b97c43625429
DIVERGENCE_POINT_AT_INSPECT=accd0a20032899f980c3324dba29aedf22034817
BASE_UNIQUE_COMMITS=15
TASK_UNIQUE_COMMITS=0
TASK_BRANCH_AT_PREFLIGHT=DETACHED
TASK_WORKTREE_DIRTY_AT_PREFLIGHT=0
BASE_WORKTREE_DIRTY_AT_PREFLIGHT=0
REMOTE_AVAILABLE=1
REMOTE_REFRESH=SKIPPED_USER_REQUESTED_LOCAL_MAIN
WORKFLOW_INTENT=SYNC_LOCAL_BASE_INTO_TASK_WORKTREE_ONLY
WORKFLOW_SELECTION=EXPLICIT_ONE_WAY
WORKFLOW_MODE=SYNC_LOCAL_BASE_INTO_TASK_ONLY
HAND_BACK_ALLOWED=0
PUSH_ALLOWED=0
BASE_TIP_ON_TASK_FIRST_PARENT_CHAIN_AT_INSPECT=0
SEMANTIC_RECONCILIATION_REQUIRED=0
TASK_WIP_STASH_STATUS=NOT_REQUIRED_TASK_WORKTREE_CLEAN
BASE_REF_LOCK_STATUS=AVAILABLE
POST_ABSORPTION_REVIEW_OWNER=STANDALONE_SYNC
ONE_WAY=VERIFIED
BASE_UNCHANGED_BY_TASK=VERIFIED
NO_HANDBACK=VERIFIED
NO_PUSH=VERIFIED
BOOTSTRAP_SEQUENCE=VERIFIED_SYNC_BEFORE_TARGET_REPOSITORY_VALIDATION
BOOTSTRAP_RECEIPT=VERIFIED
LOCAL_BASE_DELTA_INSPECTED=VERIFIED
LOCAL_BASE_ABSORPTION=COMPLETED
SIBLING_TASK_SURVEY_ENTRY=BY_NAME
SIBLING_TASK_SURVEY=VERIFIED
TASK_INVENTORY_SOURCE=KANBAN_CLI
SIBLING_TASK_COUNT=215
SOFT_OVERLAP_TASK_IDS=24508,6d284,c269f,cd144,f75af
HARD_COLLISION_TASK_IDS=NONE
NO_SIBLING_WORKTREE_MUTATION=VERIFIED
NO_SIBLING_WORK_MERGED=VERIFIED
PLAN_REVISION=APPLIED
POST_ABSORPTION_PLAN_FRESHNESS=VERIFIED
```

Bootstrap receipt 位于本 task 的 absolute git-dir 下：`base-branch-sync/local-base-into-task-worktree-bootstrap-receipt.json`。固定吸收 tip、同步结束的 local main 与 task HEAD 均为 `0461eca855031ca00c7dfe3ac284b97c43625429`。没有创建 stash，无待恢复内容；计划文档为同步后新增的唯一任务改动。


## 实现验证记录（2026-09-12）

- 根 / Web 类型检查通过；修改的 TypeScript 文件 Biome 通过，`git diff --check` 通过。
- 最终定向回归：10 文件、237 测试通过（guarded runner，包括 AST 安全策略与仓库变更 canary）。覆盖 adapter 启动矩阵、就绪/动画、用户/权限/退出取消、后续投递、连接中断续跑、恢复寻址、恢复时间戳守卫、fork 参数快照与 park。
- 真实 Codex 短 Plan：原生会话 `01a09522-cc3a-7d62-8f0c-e9f42484bbb6`，目标用户消息 1 条，收到目标回复，首轮 `plan`。
- 真实 Codex 长 Plan：原生会话 `01a09522-c85c-7850-b383-9f06fb17bda2`，中文多行及 emoji，目标用户消息 1 条，收到目标回复，首轮 `plan`。隔离 HOME / CODEX_HOME / cwd，结束清理测试进程与凭据副本。
- 最终可重跑脚本验收：1476 字符长 Plan 原文完全相等（会话 `01a09527-db9a-7901-8afd-45ff510a4997`），普通 argv 首发原文完全相等（会话 `01a09527-df8e-7d72-8273-b9824e4574b7`）；各仅 1 条目标用户消息并收到回复，模式分别为 `plan` / `default`。两次都完成隔离数据及进程清理。
- 可重跑的真机检查：`.plan/verification/codex-startup-real-pty-smoke.mjs`。使用本机有效模型，必须核对原文完全相等、用户消息数与首轮模式，不能仅凭 PTY 写出或 running 状态判通过。
- 主分支仍为 `0461eca855031ca00c7dfe3ac284b97c43625429`，未创建提交、未推送、未部署。

### 部署后验证分析

| 可观察行为 | 部署前已证 | 部署后仍待验 | 类型 |
| --- | --- | --- | --- |
| 原始首发、长文本与 Plan 语义 | adapter / PTY mock + 隔离真实 Codex | 安装的 dist、真实 runtime 配置/hooks 与 CLI 建卡启动链路组合正确 | automated_script |
| 恢复不重发、ID 寻址及权限参数 | adapter / manager 回归 | 无新增专门部署断言 | 不重复注册 |
| 用户接管、权限待答、退出停止自动 CR | 假时钟与真实镜像回归 | 已包含于共享提交逻辑，不额外建人工项 | 不重复注册 |

已注册 `2a63047a-e76a-4c91-aa69-093c2ac00d15`，资产位于 `~/.cline/kanban/verifications/2a63047a-e76a-4c91-aa69-093c2ac00d15/verify-codex-first-message.cjs`，不依赖任务 worktree。脚本通过 `KANBAN_RUNTIME_HOST` / `KANBAN_RUNTIME_PORT` 指定的实例创建带 `[vrf:…]` 标记的测试任务，核对目标转录的 session ID、正文逐字相等、用户消息数与 Plan 模式，最后经 CLI 删除自己创建的任务。

旧运行实例 dry-run 未观察到目标首发，脚本按断言失败退出（非 runner 超时或崩溃）；临时任务 `de1a9` 已删除，CLI 查询确认不存在，git worktree 清单也无残留。该 dry-run 验证的是脚本能够失败并完成清理，不代表旧实例行为通过。无 repo 临时插桩。

兜底清理：`kanban verification cleanup --verification-id 2a63047a-e76a-4c91-aa69-093c2ac00d15`。自动清理也会在整任务部署核对完成后删资产并注销定义。

## RVF 修复补充（2026-09-12）

两路外部 reviewer 完成审查，四项独立问题均由隔离 fix attempt 验证修复并合回：

1. 浏览器 xterm 的设备查询应答、焦点/鼠标报告只作原样协议透传，不触发人类接管；真正按键和混合文本仍取消自动提交。真实 xterm 分片查询经 onData 回送的回归验证首发与确认阶段均不丢失；真实 PTY 脚本新增 `--terminal-protocol-replies` 场景。
2. 回执记录本次提交 CR 的输出序号，区分仅粘贴与已提交；人类接管/模态会永久停止自动 CR，结算只使用原回执及接管前的证据。Codex 正文仍在框中时不因动画误判成功；旧 incarnation 或后续投递不得改变结论。不扩展全局回执状态契约。
3. Claude readiness 测试保持会话存活跨过 deadline，并直接验证 readiness 清除启动 timer，避免 stopTaskSession 提前清理掩盖回归。
4. OMP ACP 文档同步新字段名，以稳定 `ompAdapter` 符号替代旧行号；这是唯一新增的直接关联文档路径。

最终验证与逐项归因：`/Users/bominzhang/.rvf/user-local-data/run-logs/runs/rvf-20260912T102956Z-agentic-initiation-start-2f0cc5d1/artifacts/handoff.md`。
部署后验证 reconcile：仍复用 `2a63047a-e76a-4c91-aa69-093c2ac00d15`，定义 diff 为零，不重复注册；尚未部署。
