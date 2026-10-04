# Batch 1 性能改进 — 实施日志（implementation log）

> 配套文档：批准计划见同目录 `perf-batch1-approved-plan.md`；交接与剩余工作见 `perf-batch1-handoff.md`。
> 本日志记录 task 3fe15（worktree `~/.cline/worktrees/3fe15/cline-kanban`）2026-08-15 实施、2026-08-28 RVF、2026-09-07 land 的完整过程。所有行号以对应提交时刻为准。

## 1. 实施方式

- 计划批准后（用户选定「Batch 1 低开销改进」，不含 Batch 2 的 A-P1-2 Worker 化与 React.memo(TaskEditorDialog)），按文件冲突归并成 **9 个互不重叠的子任务**，AgentSwarm 并行实施，主会话做全局验证。
- 每个子任务强制：最小改动、贴合周围风格、不用 any / inline import、改完跑指定测试并全绿、不做任何 git mutation。

## 2. 逐项实施结果（B1–B11，B9 后被 bootstrap 撤销）

| 项 | 实施内容 | 测试 | 关键偏差/发现 |
|---|---|---|---|
| B1+B2 | `use-runtime-state-stream.ts` merge 惰性拷贝 + 引用 bailout；删除 reducer 的 `task_sessions_updated` 分支，改 `onTaskSessionSummaries` applier 旁路（`use-workspace-sync.ts` 注册，`use-project-navigation.ts`/`App.tsx` 接线） | merge 5 例 + stream 1 例 + sync 1 例，3 文件 20 例绿 | ① 计划 (a) 中「reducer 有变化时仍新建 workspaceState」一条落空置——保留它会让 Render#1 回归，故整支删除；② 有意行为差：pre-snapshot 窗口的批次现在直接并入 App sessions（有 updatedAt 单调 + 空壳守卫兜底）；③ 未用计划字面的「ref+版本号」（那仍会两次渲染），改用 ref 注册 applier |
| B3 | `dependency-overlay.tsx` childList 遍历 MutationRecord，仅 `[data-task-id]`/`[data-column-id]` 子树增删才刷新 | 新建 4 例；反证过（改回旧回调用例 1 变红） | jsdom 无 ResizeObserver，组件内守卫天然跳过，无需 polyfill |
| B4 | `task-edit-drafts.ts`（实际在 `hooks/` 不是计划的 `utils/`）新增 `areTaskImagesEqual`，替换 4 处 stringify | 新文件 19 例（含 13 组 ≡stringify 等价断言）+ use-task-editor 4 带图用例 | `name` 必须参与比较（只改文件名不能误判没动）；字段是 `data` 不是 plan 写的 `dataUrl` |
| B5 | `use-board-interactions.ts` Rule A 引用短路 | 31/31 绿（新增 3 例） | 两处必要语义补丁，各带测试：`deferredRetryTaskIds`（被 blocked/动画接管的移列下 tick 重试，否则裸短路会永久卡住）；`previousAutoFlowBoardRef`（board 外部变更时放开全量重估，否则 level-triggered 重估被吞） |
| B6 | `runtime-state-hub.ts` 去重下沉进 `broadcastRuntimeProjectsUpdated`（所有调用点受益；全局单份指纹而非 per-workspace——payload 本身全局）；复用已序列化字符串省 per-client stringify | 新建 `test/runtime/server/runtime-state-hub-projects-broadcast.test.ts` 3 例（真实 in-process HTTP+WS 握手） | 只在**发送层**去重；payload 构建（每 project 一次 board 读盘）仍每 150ms 发生，彻底省掉需 registry 侧失效式缓存（未做） |
| B7 | 新建 `use-shared-fine-clock.ts`（带 `enabled` 门控参数，粗时钟范式）；7 处 Tooltip 接 hover 门控；3 处 `toLocaleString` memo | 新时钟 7 例 + board-card 56 + elapsed-pills 9 = 72 绿 | 有意行为变化：行内 Edit/Copy 按钮 Tab 聚焦（无 hover）时不再弹 tooltip 浮层，aria-label 保留 |
| B8 | `upsertMessage` 引用快路径；窗口化 `visibleMessages` 包 useMemo | 两文件 20 例绿 | 快路径在 findIndex 之后（需先按 id 定位） |
| B9 | Spotlight 空 query 跳过签名重算 + NUL 字节转义 | 8/8 + 反证 | **后被 bootstrap 撤销**：上游 base 引入了「空 query 浏览全部任务」（`isBrowsingAllTasksWithoutQueryEnabled`），语义冲突取 base 版本。`:95` 仍残留一个字面 `\x01`（存量，未动） |
| B10+B11 | motion 防回魂 manifest 断言；scroll store 测试 8 例 + board-column 恢复测试 2 例；store 写入侧拒写损坏值 + 同值跳过 + 参数改名 `workspaceKey`；3 处撒谎注释修正；sensors 模块常量；pin-layout NUL 转义；`useRef(read…)` 改惰性 `useState` | 35/35 绿 | 两处 NUL 文件原本被 git/Read 判 binary，用 perl/python 按字节替换后恢复文本 |

## 3. 全局验证（实施批收尾，2026-08-15）

- 根 `npm run typecheck` + web-ui `tsc --noEmit`：干净
- 根 `npm run test:precommit`：139 文件 / 1829 例全绿；web-ui `npx vitest run`：148 文件 / 1370 例全绿
- biome check 35 个改动文件：干净（3 处纯格式已 `--write`）
- `npm run build`：主 chunk 3.93 MB（基线 3.89 MB，+1% 为新增代码；bundle 构成未动）

## 4. 部署后验证注册（cline-kanban-post-deploy-verification-authoring）

注册 3 条到 task 3fe15（详见 handoff §4.3）：automated 1 条（projects 广播去重 WS 观察，脚本在 `~/.cline/kanban/verifications/8f967724-…/run.js`，WS 路径 `/api/runtime/ws`——初稿写成 `/ws/runtime-state` 已修正；旧实例 dry-run 如期判失败 12:6、无 crash/残留）+ guided 2 条（Profiler 渲染频率、hover Forced reflow）。

## 5. RVF 轮（run rvf-20260828T162256Z-agentic-initiation-start-6e9b08dc，2026-08-28）

- dispatch 前做了 local base 单向吸收（bootstrap receipt 已写，吸收时 base tip `53846c4a`）；冲突解决使 `AGENTS.md`、spotlight controller 及测试回 base（B9 撤销），`docs/runbooks/runtime-summary-field-and-toggle.md` 纳入 scope。
- 双评审 strict 2/2：cursor-cli `no_issues`；claude-code 4 条 canonical issue，全部 fixed：
  - RVF-001（medium）指纹去重破坏新客户端握手自愈 → 新客户端注册时指纹置回 null + 回归用例
  - RVF-002（medium，原 ELEVATE 转普通修复）指纹含 `lastOutputAt` 活跃期永不命中 → 保留实现、注释如实化（排除易变字段会让 overview 活性展示停滞，属回退）
  - RVF-003（medium）childList 过滤过窄（卡片内条件区块高度变化不刷新依赖线）→ 收窄为「完全落在 `data-card-hover-actions` 标记内」才跳过，`task-card-body.tsx` 四处宿主挂标记 + 2 条判别用例
  - RVF-004（low）runbook 行号 :35/:248/:350 → :37/:264/:381
- 归因诚实标注：RVF-002 的 `rvf_fix_attempt.py apply` 返回 merge_conflict（与 RVF-001 撞同一注释块），由主会话手工等价合入。
- 验证 001–005 记录于 `artifacts/validation-records.json`。**005 一度 failed 是 cwd 指到仓根的假失败**（跑了根 vitest 而非 web-ui）；land 阶段以 `--working-directory web-ui` 重跑 passed 并写回记录。

## 6. Land 与 base sync（2026-09-07）

- `rvf-land`：intake 退出码 0、同 worktree 确认；sanity-check 自洽（4 条修复逐一在 worktree 核对、35 文件全在 scope、B9 三文件零改动）；commit **`6accac9e`**（35 文件 +2262/−117）；round baseline 封窗到该 HEAD。
- reviewed candidate evidence **fail-closed 未写**：run 的 handoff.md 是自由格式，缺 writer 要求的机器可校验标记（`handoff_status: COMPLETED` 等），未为通过校验篡改 artifact。
- `base-branch-sync` handback：远程同步 LOCAL_BASE_CONTAINS_REMOTE；task 吸收 base tip `accd0a20`（base 带来建卡 AI 起名/伪 HTML 块、DeepSeek 凭据注册表；交集两文件测试 97 例绿；吸收后 precommit 2152 例绿）；Tier 1 MERGE_NO_FF 落地，三条后置条件 exit 0 → local main **`63608548`**；锁已释放；base 未 push；detached task branch 按规则跳过 push。
- handoff 文档经用户批准后作为 `63cca6d1` 随 sync 一并回灌。
- 后续任务：041d9（codex，backlog），prompt 指向 handoff + 本日志 + 批准计划。
