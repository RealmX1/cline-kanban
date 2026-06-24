# 会话状态双轴 facet —— 检测方式与每个取值的实际对应（参考）

> 本文是 cline-kanban 会话状态「双轴 facet 模型」的检测/取值参考。配套实施计划见 `~/.claude/plans/generally-speaking-it-is-elegant-lobster.md`（Stage 0–5）。
>
> **核实状态**：file:line 以「Stage 4 双轴 facet 全写侧反转」落地后的工作树为准；本文内容经一轮多代理深读 + 对抗核验（`overallAccurate: true`，零修正）。
>
> **一句话**：一个 facet = 会话状态的**一根独立正交坐标轴**。这次重构把过载的一维 `state` 枚举换成**三根正交轴**：`turnOwner`（该谁动）×`liveness`（执行活性）×`userTurnKind`（轮到人时在等什么）。

---

## 0. 三层真相源（务必分清，混读必出 bug）

| 层 | 是什么 | 谁产出 | 能否落盘/广播 |
|---|---|---|---|
| **存储 facet** | `turnOwner` / `liveness`（基值）/ `userTurnKind` | 写点经 builder 发完整三元组 | ✅ 落盘 + 广播 |
| **派生显示叠加** | `computing` / `quiet` | `deriveDisplayLiveness`（对 `live` 按输出新鲜度细分） | ❌ 从不存储（随时间漂移、一写即 stale），仅有重渲染 tick 的展示型消费者读 |
| **legacy 投影** | `state`（idle/running/awaiting_review/failed/interrupted） | `projectLegacyState(facets)` | 仅作向后兼容输出；**有损**（live & exited 都压扁成 awaiting_review、retrying 压扁成 running） |

**读侧铁律**：决策型消费者一律经 `resolveSessionFacets(summary)` 读 facet，**绝不读 `summary.state`**（有损）；`computing`/`quiet` **绝不进决策/通知**，只进展示。

---

## 1. 单源映射 `deriveSessionFacetsFromLegacyState(state, ctx)`

所有检测最终汇到这一张表（`src/core/session-activity.ts:126-160`）。ctx = `{reviewReason, pid, connectionRetryActive, agentId}`。两条检测路（活系统新写 / 旧盘回填）共用它，故结果恒一致、`projectLegacyState ∘ derive` 可逆。

| 输入 legacy `state` | `turnOwner` | `liveness` | `userTurnKind` | ctx 如何参与 |
|---|---|---|---|---|
| `idle` | `null` | `none` | `null` | ctx 全不参与 |
| `running` | `agent` | `connectionRetryActive ? retrying : live` | `null` | 仅 `connectionRetryActive` |
| `awaiting_review` | `user` | `(agentId==="cline" \|\| pid!==null) ? live : exited` | `deriveUserTurnKind(reviewReason)` | `agentId`+`pid` 定存活、`reviewReason` 定人轴 |
| `failed` | `user` | `failed` | `error` | ctx 全不参与（硬编码） |
| `interrupted` | `user` | `interrupted` | `interrupted` | ctx 全不参与（硬编码） |

`deriveUserTurnKind(reviewReason)`（`session-activity.ts:106-120`）：`error→error`、`interrupted→interrupted`、`exit`/`completion`/`hook→review`、其余（`attention`/null/未知）→`needs_input`。**恒非 null**（满足 user 回合人轴不可为 null 的不变量）。**注意它产不出 question/plan_review/permission**——这三者只能靠 harness 采集 override。

---

## 2. Facet `turnOwner`（现在该谁动）

最干净的一轴：与 legacy state **1:1、无 harness 不对称**（不对称全落在 liveness）。

| 值 | 检测信号 | 实际对应 |
|---|---|---|
| **`agent`** | `state==="running"` 的写点：Cline 任一流式帧（assistant text/reasoning delta、agent chunk、工具开始）→`deriveClineFacetPatch("running")`；终端 launch/续跑→`buildTerminalFacetPatch("running")`；reducer `prompt-ready`/`hook.to_in_progress` 把待审拉回跑。**强制 `userTurnKind=null`** | 该 agent 持有这一回合、应由它推进：Cline 在产 token/调工具，或终端 agent 进程活着且没停在检查点。看板 "In Progress" 活跃卡 |
| **`user`** | 三个 legacy state 都产 user：`awaiting_review`（完成/exit/hook/提问/权限）、`failed`（spawn 失败）、`interrupted`。**恒附非 null `userTurnKind`** | 轮到人：agent 交还控制权在等你。Review/Validation 列卡；除 interrupted 外都触发 ready-for-review 通知 |
| **`null`** | `state==="idle"`：初始种子 `createDefaultSummary`、Cline turn-canceled、终端 shell 干净退出、`recoverStaleSession` 回收陈旧会话。**强制 `liveness=none`+`userTurnKind=null`** | 无进行中的回合：未启动、被取消、纯 shell 已退、或疑似死会话被复位。`isSessionInActiveTurn` 与 `isAwaitingUserReviewTurn` 均假 |

---

## 3. Facet `liveness`（执行活性）

7 个**存储**值 + 2 个**时间派生**叠加。harness 不对称的集中地。

| 值 | 检测信号 | 实际对应 | harness |
|---|---|---|---|
| **`none`** | `state==="idle"` 分支硬返回 | 无活动会话/无回合 | 对称 |
| **`starting`** | ⚠️ **schema 合法但写侧不可达的死值**。注释定义「spawn 后首条 PTY 输出前」，但 `running` 分支只产 live/retrying，spawn 成功直接写 live。全仓 grep 仅命中 schema 枚举本身，**零写点** | 理论上的极短启动窗口；现实未单独建模。为未来预留 | 两路皆不产 |
| **`live`** | (a) agent 回合 `running` 无 retry；(b) user 回合且仍存活（Cline 任一待审，或终端 agent 进程未退的待审） | 会话真正活着。**live ≠ 此刻在算**——是否在算由 computing/quiet 细分 | awaiting 的 live↔exited 不对称（见下） |
| **`retrying`** | `running` 且 `connectionRetry!=null`。实际是 `applyConnectionRetryState` 发的 **connectionRetry-only 元数据补丁**（`session-manager.ts:520-533`），经 `mergeSummaryWithFacets` metadata-only 分支重派 | 终端 agent 因瞬时连接错误（VPN 抖动/5xx）停在提示符，自动续跑框架指数退避重试注入 | **仅终端 agent**（输出反应引擎只挂终端 agent） |
| **`exited`** | user 回合 `awaiting_review` 且 `agentId≠"cline"` 且 `pid===null`。**命门**：reducer `process.exit` 必须传字面 `pid:null`（非 `summary.pid`）给 `buildFacetPatch`（`session-state-machine.ts:96-111`） | 终端 agent 进程已退（PTY 关闭）但仍停在等人审。UI "Terminal stream closed"。legacy state 有损压扁、facet 保真的关键点 | **仅终端 agent，Cline 永不进** |
| **`failed`** | `state==="failed"` 硬返回 `{user,failed,error}`。唯一来源：终端 `PtySession.spawn` 抛错 catch（`session-manager.ts:904-909/1124-1128`） | agent CLI 启动就失败（命令找不到/ENOENT），进程根本没起来 | **仅终端 agent**（Cline 错误走 awaiting+error→live） |
| **`interrupted`** | `state==="interrupted"` 硬返回。终端经 `process.exit` 的 `wasInterrupted()`（含 shutdown `markInterruptedAndStopAll`）；Cline 经 SDK abort/aborted 事件 | 被显式打断/中止（abort、Ctrl-C、Kanban 关停）。**唯一被通知排除的终止态**（`isNotifiableUserTurn` 排 interrupted；`isSessionInActiveTurn`/`isAwaitingUserReviewTurn` 对它皆假） | 两路皆可（信号不同） |
| `computing`（派生） | `deriveDisplayLiveness`：仅当基值 `live` 且距最近 PTY 输出 `< 5s` 活跃窗（`session-activity.ts:327-337`） | agent 此刻确实在持续产出（spinner 在刷） | 对称（仅看 lastOutputAt） |
| `quiet`（派生） | 基值 `live` 但输出已静默（≥5s 或从未输出） | 活着但静默（长思考/卡住/prompt 待命）。停 spinner 但不打回卡片 | 对称 |

---

## 4. Facet `userTurnKind`（轮到人时他在等什么，仅 `turnOwner="user"`）

旧盘单源派生 `deriveUserTurnKind` **只能产 4 种**（review/error/interrupted/needs_input）；**question/plan_review/permission 是 harness 采集 override 独有、永远无法从旧盘回填**。

| 值 | 检测信号 | 实际对应 | harness |
|---|---|---|---|
| **`review`** | `reviewReason∈{exit,completion,hook}`（无 override 时）：Cline 自然完成(completion)/进程 ended(exit)；终端 Stop hook(hook) | agent 把这轮干完、交回等审。卡片绿点 "Waiting for review" | 两路（Cline 多走 completion/exit；终端「未退待审」靠 Stop hook） |
| **`question`** | Cline：`classifyClineUserAttentionTool` 命中 `ask_followup_question`（`cline-session-state.ts:40-52`）。Claude（Stage 5）：`classifyHookUserTurnKind` 命中 `toolName==="AskUserQuestion"`（`harness-user-turn-kind-collection.ts`）。均经 override 注入 | agent 主动用工具提了澄清问题、停下等回答 | **Cline SDK + Claude Code**（Stage 5 已实现，Claude 经 `AskUserQuestion` 工具） |
| **`plan_review`** | Cline：同采集点命中 `plan_mode_respond`。Claude（Stage 5）：`classifyHookUserTurnKind` 命中 `toolName==="ExitPlanMode"` | plan 模式呈递计划等批准 | **Cline SDK + Claude Code**（Stage 5 已实现，Claude 经 `ExitPlanMode` 工具） |
| **`permission`** | `classifyHookUserTurnKind` 门控 `source==="claude"` 且 `PermissionRequest`/`permission_prompt`**且无 ExitPlanMode/AskUserQuestion 工具名**（toolName 分支优先，见下注），经 `hooks-api→transitionToReview(override)→reducer`（`harness-user-turn-kind-collection.ts`、`hooks-api.ts`） | Claude Code 弹权限确认（通用工具如 Bash/Edit），等你授权 | **仅 Claude 终端**；自治模式 `--dangerously-skip-permissions` 下基本不触发 |
| **`error`** | `reviewReason==="error"`：Cline 不可恢复错误/额度耗尽；终端进程非零码退出；spawn 失败（此时 liveness=failed） | agent 因运行时报错停下等你看。卡片红点 "Encountered an error" | 两路（Cline error→live；终端崩溃→exited；spawn→failed） |
| **`interrupted`** | `state==="interrupted"` 直接产 | 被显式打断收尾。**唯一被 `isNotifiableUserTurn` 排除的人轴**，不通知 | 两路 |
| **`needs_input`** | 兜底：`reviewReason==="attention"`（主要来自 `resumeFromTrash`）及 null/未知 | 笼统「需要你输入」但无更细归类。卡片金点 "Needs your input"。catch-all 默认 | 终端 agent 更易落此（attention/prompt-detector 体系） |
| **`null`** | `turnOwner≠"user"` 时由 superRefine 强制 | 不是用户的回合（agent 在跑或无会话） | 对称 |

---

## 5. 写侧管线（facet 怎么被写进 summary）

```
事件/生命周期
  ├─ Cline SDK    → deriveClineFacetPatch(state, reviewReason, override?)   [pid:null, agentId:"cline", connectionRetryActive:false]
  ├─ 终端/PTY     → buildTerminalFacetPatch(prev, state, {pid,agentId,...})
  └─ reducer      → buildFacetPatch(summary, state, ctx, override?)         [process.exit 强制 pid:null]
        │  （三者内部都调单源映射 deriveSessionFacetsFromLegacyState，发完整 {turnOwner,liveness,userTurnKind} 三元组）
        ▼
   updateSummary 漏斗 ×2（cline-session-state.ts / session-manager.ts）
        ▼
   mergeSummaryWithFacets(prev, patch)  ── session-activity.ts:219-252
        ├─ ① facet-only patch（有 facet 无 state）→ facet 权威，state = projectLegacyState(facets)        ← Stage 4 后新写主路径
        ├─ ② state-bearing patch（有 state）→ applySessionFacets 从 state 反推三 facet                    ← 种子/兼容/落盘
        └─ ③ metadata-only patch（无 facet 无 state，如 lastOutputAt/connectionRetry）
              → 重派 turnOwner/liveness（让 connectionRetry→retrying 生效）+ **preserve 已采集的 userTurnKind**
                 （绝不让 applySessionFacets 把采集来的 question/plan_review/permission 冲回 review/needs_input —— 「最致命缺陷」防线）
        ▼
   api-contract superRefine（共生 + 合法组合，所有校验边界硬化）+ 末位 transform（state = summary.state ?? projectLegacyState(facets)）
```

合法组合（superRefine，`api-contract.ts:378-443`）：
- `turnOwner=null` ⇒ `liveness=none` 且 `userTurnKind=null`
- `turnOwner=agent` ⇒ `userTurnKind=null` 且 `liveness∈{starting,live,retrying}`
- `turnOwner=user` ⇒ `userTurnKind≠null` 且 `liveness∈{live,exited,failed,interrupted}`
- 三 facet 全缺（旧盘）→ 放行跳过组合校验；`state` 缺但 facet 不全 → 拒

**override 安全栅**：`userTurnKindOverride` 只在 `turnOwner==="user"` 时生效（builder 内守卫），agent/null 回合即便传了也忽略。**严禁裸写单个 facet 字段**（裸写 `{userTurnKind:"question"}` 到 stale summary 会撞 superRefine）。

---

## 6. harness 不对称（核心陷阱）

### 6.1 路由：哪个 agent 走哪条路
- `RUNTIME_AGENT_CATALOG`（`agent-catalog.ts:12-69`）cataloged **7 个** agent：claude / codex / cline / opencode / droid / kiro / gemini。
- **实际可启动集** `RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS`（`agent-catalog.ts:73-82`）= **{cline, claude, codex, droid, kiro}**；**`opencode` 与 `gemini` 当前 launch-DISABLED**（在该数组里被注释掉）。
- 路由 `runtime-api.ts:241` `useClinePath = effectiveAgentId === "cline"`：**仅 `cline` 走进程内 Cline SDK**；其余 launch-supported（claude/codex/droid/kiro）全走终端/PTY。

| task agent | `agentId` | 路径 | pid | launch |
|---|---|---|---|---|
| Cline | `cline` | 进程内 Cline SDK（`src/cline-sdk/`） | **恒 null** | ✅ |
| Claude Code | `claude` | 终端/PTY（`src/terminal/`） | 真实 pid | ✅ |
| OpenAI Codex | `codex` | 终端/PTY | 真实 pid | ✅ |
| Factory Droid | `droid` | 终端/PTY | 真实 pid | ✅ |
| Kiro | `kiro` | 终端/PTY | 真实 pid | ✅ |
| OpenCode | `opencode` | （终端/PTY 形态） | — | ❌ launch-disabled |
| Gemini CLI | `gemini` | （终端/PTY 形态） | — | ❌ launch-disabled |

### 6.2 可达性矩阵
关键根源：`awaiting_review` 的存活判定 `agentId==="cline" || pid!==null ? live : exited`。**Cline pid 恒 null 但 agentId==="cline" → 前半短路恒 live**。

| facet 值 | 原生 Cline（SDK） | 终端 agent（launch-supported：claude/codex/droid/kiro） |
|---|---|---|
| `liveness=exited` | ❌ 永不 | ✅ 进程退出后待审 |
| `liveness=failed` | ❌（错误走 awaiting+error→live） | ✅ spawn 失败 |
| `liveness=retrying` | ❌（无 connectionRetry 概念） | ⚠️ **仅 claude/codex**：自动续跑反应 `appliesToAgent` 只放行二者（`connection-drop-auto-continue.ts:161-163`，droid/kiro 是 first/second-priority TODO）；droid/kiro 虽终端但当前不进 retrying |
| `userTurnKind=question` | ✅ `ask_followup_question` | ✅ Stage 5（`AskUserQuestion`） |
| `userTurnKind=plan_review` | ✅ `plan_mode_respond` | ✅ Stage 5（`ExitPlanMode`） |
| `userTurnKind=permission` | ❌ | ✅ 仅 Claude（`source==="claude"` hook，自治模式下基本不触发） |

---

## 7. harness 人轴采集现状矩阵

| 人轴 kind | 原生 Cline | Claude Code | 其它终端 agent（codex / droid / kiro） |
|---|---|---|---|
| review / error / interrupted / needs_input | ✅ 单源派生 | ✅ 单源派生 | ✅ 单源派生 |
| question | ✅ `ask_followup_question` | ✅ **Stage 5**（`AskUserQuestion`） | ❌ |
| plan_review | ✅ `plan_mode_respond` | ✅ **Stage 5**（`ExitPlanMode`） | ❌ |
| permission | ❌ | ✅ `PermissionRequest`/`permission_prompt`（无特定 plan/question 工具名时；非自治模式） | ❌ |

**Stage 5（已实现）** = 给 Claude Code 补 question/plan_review：①`agent-session-adapters.ts` PreToolUse 加专用 matcher `ExitPlanMode|AskUserQuestion`→`to_review`（镜像现有 Notification `permission_prompt`+`*` 双 matcher，且 `*`→activity 保留作良性双触发）；②`classifyHookUserTurnKind` 读 `toolName`→plan_review/question；③`hooks-api` override 类型放宽 + unclassified 日志扩到 toolName。下游（facet 写/superRefine/channel C 三臂/通知措辞）Stage 4 B5 全现成。

**竞态鲁棒（关键）**：`ExitPlanMode` 经**两条** hook 路径抵达 `to_review`——新增的 `PreToolUse` matcher，与既有 `PermissionRequest` `*`→`to_review`（计划批准对话也 fire `PermissionRequest`，见 Claude hooks 文档 auto-approve `ExitPlanMode` 示例，payload 带 `tool_name=ExitPlanMode`）。两者竞争 `to_review` 闸（先到者落定人轴）。故 `classifyHookUserTurnKind` 的 **toolName 分支必须先于通用 permission 分支**：无论哪条 hook 先赢，`ExitPlanMode`/`AskUserQuestion` 都落 plan_review/question（不被误标 permission）。语义上「批准这个计划」本就是 plan_review，故 toolName 优先是更准确的归类、非特例。

**自治模式**：`--dangerously-skip-permissions` 抑制 `PermissionRequest`，故 `permission` 与「`ExitPlanMode` 经 PermissionRequest 路径」均基本不触发；但 `question`（`AskUserQuestion` 经 `PreToolUse`，与权限模式无关）仍可靠，`plan_review` 视是否进 plan 模式而定。

**log-watcher 不适用**：`commands/hook-events/claude-hook-events.ts` 的 `startClaudeSessionWatcher`（`pretooluse→activity`）**仅测试引用、无生产调用点**（对比 codex watcher 在 `hooks.ts:642` 有生产接线）；Claude 生产采集全走上述 command-hook 路径。

---

## 8. 关键陷阱速查

1. **`exited` 命门**：reducer `process.exit` 必须传字面 `pid:null`，误用 `summary.pid`（仍非空）→ 已退进程误标 live，`test:fast`/state 断言全过却悄毁 live↔exited 区分。
2. **metadata-only 必须 preserve userTurnKind**：高频心跳（lastOutputAt/connectionRetry）若误经 `applySessionFacets` 重派 → 冲掉采集来的 question/plan_review/permission。
3. **绝不裸写单 facet 字段**：一切 facet 写经 builder 发完整三元组、过漏斗，否则撞 superRefine。
4. **`state` 有损**：决策读 `resolveSessionFacets`，不读 `summary.state`。
5. **`computing`/`quiet` 不进决策/通知**：随时间漂移、无周期 tick、一写即 stale。
6. **`starting` 当前是死值**：schema 合法但无写点产出。
7. **Cline ≠ Claude Code**：Cline=进程内 SDK（pid 恒 null、awaiting 恒 live）；Claude Code=终端 agent（同 codex/droid/kiro 族，可 exited/failed，retrying 仅 claude/codex）。两路均可产 question/plan_review（Cline 经 SDK 工具名、Claude 经 `AskUserQuestion`/`ExitPlanMode`，Stage 5）；permission 仅 Claude。注意 launch-supported 集是 {cline,claude,codex,droid,kiro}，opencode/gemini 当前 launch-disabled。
8. **toolName 分支先于 permission**：`classifyHookUserTurnKind` 必须先按 `ExitPlanMode`/`AskUserQuestion` 工具名判 plan_review/question，再判通用 permission——否则 `ExitPlanMode` 经 `PermissionRequest` 路径会被误标 permission（见 §7 竞态鲁棒）。

---

## 9. 关键 file:line 索引

| 符号 | 位置 | 职责 |
|---|---|---|
| `deriveSessionFacetsFromLegacyState` | `src/core/session-activity.ts:126-160` | old→new 单源映射（两条检测路共用） |
| `deriveUserTurnKind` | `src/core/session-activity.ts:106-120` | reviewReason→人轴基线（4 种） |
| `mergeSummaryWithFacets` | `src/core/session-activity.ts:219-252` | 写侧主真相源派发器（3 分支） |
| `applySessionFacets` | `src/core/session-activity.ts:185-199` | state-权威反推三 facet（种子/兼容/回填） |
| `resolveSessionFacets` | `src/core/session-activity.ts:264-278` | 读侧 facet 权威解析 |
| `deriveDisplayLiveness` | `src/core/session-activity.ts:327-338` | computing/quiet 派生叠加 |
| `projectLegacyState` | `src/core/session-activity.ts:164-179` | new→old 投影（有损） |
| `isSessionInActiveTurn`/`isAwaitingUserReviewTurn`/`isNotifiableUserTurn` | `src/core/session-activity.ts:~287-313` | 共享判据 |
| superRefine + transform | `src/core/api-contract.ts:378-456` | 共生/合法组合守卫 + state 回填 |
| `deriveClineFacetPatch` / `classifyClineUserAttentionTool` | `src/cline-sdk/cline-session-state.ts:23-37 / 40-52` | Cline 写点 + question/plan_review 采集 |
| `buildTerminalFacetPatch` | `src/terminal/session-manager.ts:223-235` | 终端写点 facet 工厂 |
| `buildFacetPatch` / `reduceSessionTransition` | `src/terminal/session-state-machine.ts:35-54 / 56-119` | reducer facet 工厂 + 转换 |
| `transitionToReview` | `src/terminal/session-manager.ts:1293-1316` | hook 转审入口（透传 override） |
| `classifyHookUserTurnKind` | `src/core/harness-user-turn-kind-collection.ts` | Claude 采集：toolName→plan_review/question（先判），再 permission（Stage 5） |
| Claude PreToolUse 专用 matcher | `src/terminal/agent-session-adapters.ts`（`ExitPlanMode\|AskUserQuestion`→to_review） | Stage 5 采集前端（在 `*`→activity 之前） |
| `canTransitionTaskForHookEvent` | `src/trpc/hook-event-task-transition-gate.ts:22-32` | hook 事件转换闸（activity 恒 false） |
| hooks ingest（to_review override） | `src/trpc/hooks-api.ts:74-152` | override 注入 + 通知 payload 内联 |
| Claude settings.json hook 注册 | `src/terminal/agent-session-adapters.ts:697-744` | 各 hook→event baked 映射 |
| `kanban hooks` CLI（toolName 透传） | `src/commands/hooks.ts:106-107, 314-322` | stdin 抽 tool_name → metadata |
| agent-catalog / launch-supported / 路由 | `src/core/agent-catalog.ts:12-69`（catalog 7 个）/ `:73-82`（launch-supported {cline,claude,codex,droid,kiro}）/ `src/trpc/runtime-api.ts:241` | agent 定义 / 实际可启动集 / Cline vs 终端分流 |
