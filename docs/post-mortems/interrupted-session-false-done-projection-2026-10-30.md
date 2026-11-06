# 会话中断被前端误投影为已结案（2026-10-30）

用户报告 `review-validate-fix/52376` 未手动结案却显示在已结案，恢复按钮报“只能重新打开已结案任务；已修改的恢复请求不能重放”。All Projects 的 Recent 区仍收录它，但展开卡片标题划线、灰显，详情只展示 Done 只读历史。

## 已核实事实

- 服务端卡片和持久 `board.json` 均为 `in_progress`，创建时间 `1793336679328`，没有结案摘要、结案操作或重开历史。
- 原工作树 `/Users/bominzhang/.cline/worktrees/52376/review-validate-fix` 存在，detached HEAD 为 `1606f9e8736991248d26f055788024057bb7cf11`，含 3 个未提交修改文件；本次未编辑该工作树。
- 会话持久 facet 为 `user/interrupted/interrupted`，PID 为 null。PTY 退出日志记录本次进程于 `2026-10-30T16:23:18.663Z` 以 143 退出，时间接近运行实例更新；仅凭退出码与时间不能单独证明是谁发起停止。
- 恢复入口的拒绝由实际卡片仍在 `in_progress` 触发，并非发现了用户修改过恢复请求；该复合错误文案包含多个拒绝条件。

## 根因与修复

`use-board-interactions.ts` 保留“中断边沿自动移入 trash”的旧浏览器逻辑；`project-task-counts-live-session-overlay.ts` 也把中断会话计入 trash。新服务端 `preserveRuntimeOwnedTaskClosureState` 只允许生命周期动作跨越结案边界，拒绝旧整板保存直接结案，形成浏览器本地列与真实列不一致。

All Projects 分组与展开卡片、详情的来源不同：前者可继续收录服务端未结案任务，后两者按当前项目的浏览器卡片列判定划线、灰显及只读。不能只修改分组、放宽恢复接口，或伪造一条结案记录来消除不一致。

修复删除中断自动结案分支及其跳过结案流程的动画选项，中断时保留原列；项目计数同步保留原列。真正已结案卡片的共享恢复提示改为“重新打开已结案任务／复用原工作树；已清理时从归档恢复”。历史事件中的旧发起方标识继续可读。

## 本次现场恢复

通过现有 `runtime.refreshTaskTerminal` 续接原对话，空 Prompt，返回 `ok=true, mode=resume`，PID `62115`，原生会话 ID 仍为 `01a18d19-021f-7a10-99fa-60d50b921623`。未调用结案／重开动作，未重投任务初始 Prompt，未创建新工作树。
恢复后的复查显示任务已正常进入 `review`，会话为 `user/live/needs_input`；独立浏览器核验页显示可交互的 `Terminal input`，原任务路径与原生会话 ID 均匹配，不再显示 Done 只读历史。

持久现场、恢复脚本和回执：`/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/task-52376-interrupted-session-false-closure-20261030/`。

## 验证与后续

- Web 定向测试：2 个文件、82 项通过，覆盖五列保留、无自动结案发起方、无中断结案动画及 PDV 门禁提示。
- 根 guarded 测试：2 个文件、16 项通过，覆盖项目计数与服务端旧整板保存的结案边界。
- Playwright：3 项通过，覆盖 1440px／390px 的双宿主卡片无划线、无假恢复按钮、详情仍挂载 Terminal 且不请求 Done 历史；真正 Done 卡双宿主的恢复提示正确。
- Biome 与差异空白检查通过。
- 全仓及 Web 类型检查被既有依赖不匹配阻塞：已安装的 `agent-conversation-exploration-thread-graph` 缺失当前源码所需的进程监督导出，`ForkedWorkBranchRequest` 仍要求旧 `timeoutMs`。未为通过检查删改相关业务代码或既有依赖 WIP。
- 本次补丁未提交、未推送、未部署。旧运行实例在下一次会话中断时仍可能出现旧投影，需安装本次补丁才能永久修正。

## 部署后验证分析

| 行为 | 部署前已证 | 部署后待验 | 类型 |
| --- | --- | --- | --- |
| 中断保留原列、原计数，卡片与工作台不误判 Done | 根 guarded、Web hook、桌面及手机 Playwright | 无需重复注册同一逻辑 | 已覆盖 |
| 安装实例实际提供修复后的前端和计数代码 | 源码测试通过 | 安装的前后端产物是否包含补丁 | 可编程只读核验 |

已读取 `cline-kanban-post-deploy-verification-authoring` 并完成分析。本次为 Codex 桌面会话，没有 `KANBAN_HOOK_TASK_ID`；用户提供的 `52376` 属于故障对象 RVF 仓库，并非本次 Kanban 修复任务，不能把验证错挂到它。尚未注册部署后验证，也没有将任何核对项写为通过。

## 后续收编（2026-11-05）

上文保留 10 月 30 日的现场与交付事实。任务 `4269c` 在用户批准遗留改动处置方案后接管本组 17 个路径，清理另外两项过时配置锁遗留，并恢复根与 desktop 的两份 lockfile；未提交或部署。

处置前的 21 个路径、完整补丁、权限和 SHA-256 已保存在 `/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/4269c/local-main-dirty-disposition-20261105T181653Z/`。独立验证使用该目录下的隔离工作树，保留原工作区依赖和运行产物。

部署后验证现归属于 `cline-kanban/4269c`，`verificationId=d0c062ba-3e67-508e-9712-191c613c7053`。脚本只读核对运行前端与已安装服务端的 sourcemap，确认中断保留原列、原列计数及恢复提示；旧实例 dry-run 正常报告缺少补丁，未改运行状态、未将核对项标为通过。

本轮隔离验证使用 lockfile 锁定的 `agent-conversation-exploration-thread-graph@233d3e7…`，根项目与 Web UI 类型检查通过，21 项根 guarded 回归、82 项 Web 回归及 3 项桌面／手机 Playwright 回归全部通过。隔离生产构建通过，核验脚本对修复后构建的自检通过，主工作区的运行产物哈希保持不变；这些结果不代表真实运行实例已经部署或通过验证。
