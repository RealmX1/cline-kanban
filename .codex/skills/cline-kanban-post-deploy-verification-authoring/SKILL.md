---
name: cline-kanban-post-deploy-verification-authoring
description: Author Post-Deploy Verification for a Cline Kanban task as it enters the RVF (review/validate/fix) stage. Use in this project when a task's implementation is wrapping up (or you are about to declare it review-ready / done) to analyze which assertions can only be verified on the real running instance after deploy, then register them as automated-script or guided-manual verifications so they surface in the verification panel. Do NOT use for running verifications, ticking checklist items, deploying, or from inside an RVF fix sub-agent.
---

# Cline Kanban Post-Deploy Verification Authoring

## Core Rule

部署前的现场测试（unit / integration / worktree dev server）只能证明「代码在测试环境里行为正确」。有一类断言**只有部署后的真实运行实例**才验得到——真实 PTY/agent 集成、跨重启持久化、server↔web 实时链路、CLI↔live server、dist 构建差异、真实 UI 交互层级。这个 skill 让你在任务进入 RVF 阶段时：**先分析**出这类断言，再把它们注册成**自动脚本型**（可程序化观察）或**引导人工型**（只能人眼/人手观察）验证，使它们在部署后自动出现在验证面板里，让用户/开发者无需记住整张清单。

默认用用户偏好的主要语言回复；本项目要求中文，则用中文描述分析表、风险、注册结果和后续操作。

## Boundary

- 本 skill 只做**分析 + 注册验证定义**（写 definition JSON → `kanban verification register`）。它**不**运行验证、不勾选核对项、不部署、不移列。
- 只在 kanban 任务实现收尾 / 宣告完成 / 进入 review 前调用；或用户显式要求「注册部署后验证」时调用。
- 反触发：不要在「运行验证 / 点击运行按钮 / 勾选核对 / 执行部署 / RVF fix 子代理内部」的场景调用本 skill。
- RVF fix 若改变了可观察行为，land 前以 **reconcile 模式**重入本 skill（对已注册定义只 diff、幂等重注册，不重复堆叠）。

## 前置（Failure Gate）

1. 取 taskId：优先读环境变量 `KANBAN_HOOK_TASK_ID`；workspace 取 `KANBAN_HOOK_WORKSPACE_ID`（`register` 也接受 `--project-path` 定位 workspace）。
2. **Failure Gate**：`KANBAN_HOOK_TASK_ID` 缺失且用户未显式给出 taskId → **停**，向用户要 taskId，不要瞎猜。
3. 确认 `kanban` CLI 在 PATH（`kanban verification --help` 应列出 register / list / unregister / cleanup）。

## Step 1 — 分析：哪些断言只有部署后才验得到

产出一张「行为 × 部署前已证 × 部署后待验 × 类型」表：

1. 列出本次实现引入/改变的**可观察行为**（用户能看到、CLI/API 能观测的对外行为）。
2. 逐条问两个问题：
   - **部署前测试已证了什么？**（有 unit/integration/worktree dev server 覆盖的划掉）
   - **只有部署后真实实例才验得到什么？**（保留）
3. 对保留项标类型（automated_script / guided_manual，判据见 Step 2）。

**部署后待验正面清单**（命中即保留）：
- 真实 UI 交互与视觉层级、z-index、面板挂载/门控（只有真浏览器 + 真实 dist 才准）。
- 跨进程 / 跨重启持久化（写盘文件、迁移、锁）。
- 真实 PTY / agent 会话集成（终端 agent 启动、hook 收集、输出反应）。
- server ↔ web 实时链路（tRPC / WebSocket / 轮询对账）。
- CLI ↔ live server（CLI 命令经 tRPC 打到运行实例）。
- dist 构建差异（打包后行为 ≠ dev；构建期宏 / 环境注入）。
- 性能 / 时序（节流、防抖、超时、重绘）。

**排除法**（命中即划掉，不注册）：已被自动化测试、或 worktree dev server 现场测试充分覆盖、且部署不改变其结论的行为。

> 若分析后**没有**只能部署后验的断言：如实说明「本次实现均被部署前测试覆盖，无需注册部署后验证」，不要为凑数造验证。

## Step 2 — 选型判据：automated_script vs guided_manual

- 满足**全部**下列 → `automated_script`：可从外部程序化观察（CLI/HTTP/只读状态文件）、无需人眼/人手感知、幂等可重跑、副作用可回收。
- 命中**任一** → `guided_manual`：需人眼/人手/外部条件（如真浏览器视觉、真实设备）、或脚本化成本过高。
- **拿不准就选 guided_manual**（人工核对永远安全；自动脚本写错反而误导）。

## Step 3 — 编写 automated_script 验证

约定（违反即 Failure Gate）：

- **资产目录**：脚本与 fixture 放在 `register` 返回的 `assetsDir`（即 `~/.cline/kanban/verifications/<verificationId>/`）。**definition 里的路径禁止指向 task worktree**——worktree 在任务完成后会被 trash 删除，脚本随之消失。
- **单一入口**：`script.entrypoint` 是资产目录内的入口文件（如 `run.sh` / `run.js`）；`interpreter` 为 `bash` 或 `node`；`timeoutMs` 给足但别过长（默认 60000）。运行时 `cwd = assetsDir`。
- **退出码**：`0 = 通过`，非 0 = 失败（runner 无 skip 态）。前置条件不可用（如 server 不可达）→ 退出非 0 并打印清晰原因，**绝不静默 exit 0 假装通过**。
- **观察运行实例**：脚本读环境变量 `KANBAN_RUNTIME_HOST` / `KANBAN_RUNTIME_PORT` 定位运行实例；优先经 `kanban … --json` CLI 或只读状态文件观察，避免直接改运行数据。运行时还注入 `KANBAN_VERIFICATION_ID`。
- **自建实体带 tag 且无条件清理**：脚本若创建临时实体（任务、文件…），一律带 tag `[vrf:<verificationId>]` 且在 `finally` 里无条件删除。
- **禁触碰**：runtime config、用户数据、其它任务的状态。
- 骨架见 `references/automatic-script-skeleton.md`。

## Step 4 — 编写 guided_manual 验证

- `label` 写成**可勾选的观察断言**（例：「面板在真实浏览器里显示于所有卡片之上」），而非动作。
- `guidance.steps` 现场指导式：打开 X → 点 Y → 应看到 Z；**首步是定位**（去哪个视图找目标）。
- `guidance.expectedObservation`（判定通过的观察）与 `guidance.failureSignature`（失败长什么样）**分述**。
- `guidance.anchor` 用**稳定的 `data-verification-anchor` 键**，指向被引导的真实 UI 元素。可用键构造见 `web-ui/src/components/post-deploy-verification/verification-anchor-registry.ts`：
  - `board-task-card:<taskId>`（看板任务卡）
  - `board-column:<columnId>`（看板某列；**需自行挂锚点的扩展键**——当前没有列容器默认挂 `data-verification-anchor`，使用时须在同一变更内给目标列容器挂上，否则 spotlight 只能降级）
  - `task-detail:<taskId>`（Focus/Detail 视图任务详情容器）
  - `verification-panel-task:<taskId>`（面板内任务卡，也是无 anchor 时的降级目标）
  - `anchor.view` 为 `board`（导航回看板）或 `task_detail`（打开该任务详情）。指向新 UI 元素时，同一 PR 内给目标元素挂上对应的 `data-verification-anchor`。
- definition 示例见 `references/definition-examples.md`。

## Step 5 — 注册与验收

1. 写 definition JSON（单个对象或数组）到临时文件。
2. `kanban verification register --task-id <id> [--project-path <p>] --definition-file <path.json>` → 返回每条的 `verificationId` + `assetsDir`。把脚本 / fixture 落进返回的 `assetsDir`。
3. **注册前 dry-run（automated 必做）**：在**旧运行实例**上把脚本手动跑一遍（`bash <assetsDir>/run.sh`）。**允许 fail**（旧版本本就没这行为），但**禁止 crash / 超时 / 留残留**。crash 或留垃圾即修脚本重来。
4. 自查：`kanban verification list --task-id <id>` 与 `kanban deployment verification-state --active-only`（部署后）确认定义已挂载。
5. **多轮 / rvf-reopen 幂等**：重入本 skill 时，对已注册的 verificationId 用同 id 重注册（`register` 按 verificationId upsert 替换），只 diff 变化项，不堆叠重复定义。

## Step 6 — 清理规格

- 每条验证声明 `cleanup`：
  - `automatic`：整任务核对完成时自动删 `assetsDir` + 注销定义。**仅当资产完全在 `assetsDir` 内、无 repo 侧改动**时可用。
  - `manual`：保留资产，`manualSteps` 写清人工清理命令；面板展示这些步骤。
  - `retain`：刻意保留。
- **repo instrumentation 强制 manual（Failure Gate）**：若验证需要往**已提交的 repo 代码**里插桩（临时日志 / 探针），该验证**必须** `cleanup.mode="manual"`（已提交代码无法靠删目录自动清理）。插桩块用 tag 注释 `// KANBAN-VERIFICATION-SCOPED:<verificationId>`（多行块用 `-BEGIN` / `-END` 配对），`manualSteps` 写 grep 移除命令（如 `grep -rn "KANBAN-VERIFICATION-SCOPED:<verificationId>" src`）。
- 无论何种 mode，都在最终汇报里附**兜底人工清理文本**：`kanban verification cleanup --verification-id <id>`（删资产 + 注销）与 instrumentation 的 tag 扫描命令。

## Failure Gates（任一命中即停并说明）

- 无 taskId（`KANBAN_HOOK_TASK_ID` 缺失且用户未给）。
- automated definition 的 `script` 为空，或 `entrypoint` 指向 task worktree。
- dry-run 出现 crash / 超时 / 残留未清。
- 含 repo instrumentation 却用了 `automatic` 清理。
- 造了自动化测试就能覆盖的「假部署后验证」凑数。

## Output Expectations

汇报中给出：
1. **分析表**：行为 × 部署前已证 × 部署后待验 × 类型。
2. **注册清单**：每条 verificationId + kind + label + assetsDir + cleanup.mode。
3. **dry-run 结果**：automated 各条在旧实例上的运行结论（pass/fail 都算通过 gate，只要不 crash/超时/留残留）。
4. **自查 JSON**：`verification list` 输出摘要。
5. **挂载预告**：部署 `record` 后本组预计挂载的 automated / guided 条数。
6. **兜底清理文本**：每条的 `kanban verification cleanup --verification-id <id>` + instrumentation tag 扫描命令。
