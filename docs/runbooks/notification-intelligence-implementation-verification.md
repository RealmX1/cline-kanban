# 智能通知实现与验证记录（8dc89）

状态：源码已实现，未提交、未部署。配置仍需用户提供 BYOK；验证没有使用真实付费凭据，也没有写入真实系统钥匙串。

## 实现前核对

```text
LOCAL_BASE_DELTA_INSPECTED=VERIFIED
LOCAL_BASE_ABSORPTION=COMPLETED
SIBLING_TASK_SURVEY=VERIFIED
NO_SIBLING_WORKTREE_MUTATION=VERIFIED
NO_SIBLING_WORK_MERGED=VERIFIED
PLAN_REVISION=APPLIED
POST_ABSORPTION_PLAN_FRESHNESS=VERIFIED
```

本地 `main`、核对时 base 与吸收后 base 均为 `932e65184d9dbeb298597fdd47ad577596580fec`，与 task 起点一致；没有 base 独有增量。按既有 skill 完成加锁、匹配 origin 的 fetch、单向吸收和边界验证；没有 handback/push。bootstrap receipt 在本任务 git-dir 的 `base-branch-sync/local-base-into-task-worktree-bootstrap-receipt.json`，内容摘要 SHA-256 为 `c10ad6508b891ddb923e4b16ae73d28c42fb690ed8675bc35b14a0297baced19`。

Sibling inventory 经 CLI 取得，共 223 条，无采集降级。软重叠：`07683`、`9674c`、`f78bf` 的既有通知、provider/设置和运行时相关工作；沿用当前主线契约，未吸收 sibling 未落地内容。硬碰撞：无活跃未提交文件碰撞。详情采集留在 `/tmp/8dc89-sibling-survey.json`。

## 部署前验证

| 范围 | 结果 |
| --- | --- |
| 根与 Web TypeScript | 通过 |
| 新增通知/BYOK/AI/音频专项及 hook 回归 | 42 项通过 |
| 通知存储与实时通知集成 | 10 项通过（按 notification/ready/review 筛选，另 10 项不在此次筛选） |
| Web 全量 | 173 文件、1,689 项通过；随后新增历史按钮回归与最终通知相关 40 项通过 |
| Desktop | 类型检查通过；231 项通过，1 项原有 todo |
| 根全量 | 2,437 项通过、3 项失败；下面列明对照结果，不能称为全绿 |
| 容量与持久化 | 100,000 条档案分页、全量已读、清空后全量保留；跨连接原子领取；音频文件写完但 DB 确认前中断的恢复通过 |
| 原生兼容 | Node 20.20.2 的 SQLite worker/keyring 加载通过；运行时与主要套件在 Node 22.22.3；Electron 41.5.0 / Node 24.15.0 的原生模块与 worker 读写通过 |
| 打包态浏览器 | 隔离 HOME、端口 43891；设置保存/重载、105 条历史分页、全量未读 104、全部已读、清空后面板 0 而历史仍 105、被筛掉信号的原文/AI 理由查看均通过；最终重启后仍为历史 105、面板 0、DeepInfra 配置保留，浏览器控制台无错误 |

根全量失败对照：

1. `cli-compat.integration.test.ts`：宿主同时设置 `NO_COLOR` / `FORCE_COLOR`，Node 向 stderr 写警告，违反旧测试的 stderr 必须为空断言。未修改基线也失败。
2. `runtime-state-stream.integration.test.ts:1165`：旧测试期望 trash 任务不在 metadata 中，实际包含。未修改基线同样失败，未在本任务改动其语义。
3. `terminal-echo-latency.integration.test.ts`：全量运行时未在 2 秒内观察到 echo；当前实现和未修改基线的隔离复跑均通过。

基线为从本任务 HEAD 建立的临时 detached worktree，使用相同依赖，比较上述三项；没有提交或改动主仓库源代码。该基线 worktree、隔离浏览器/运行实例及测试 HOME 已清理。日志保存在 `/tmp/8dc89-full-root-tests2.log`、`/tmp/8dc89-clean-baseline-comparison.log`、`/tmp/8dc89-baseline-comparison.log`。

构建环境问题及修复：本 task 原来的 `dist` 和 `web-ui/dist` 是指向主仓库产物的软链接，早期构建曾经写入其目标。发现后将本 task 两个路径改为独立目录，并按主仓库未修改的源码重新生成主仓库运行时/Web 产物（不是逐字节备份恢复）；主仓库 CLI `--version` 校验通过。没有重启真实运行实例，没有修改其配置、任务数据或源代码。后续所有打包验证都使用独立目录。原生 SQLite 需要安装时 Node ABI 与运行 Node 匹配；隔离实例最终使用安装依赖的 Node 22，另做 Node 20 和 Electron 的独立原生构建验证。

## 部署后验证分析与登记

按仓库 skill `cline-kanban-post-deploy-verification-authoring` 登记，不运行、不勾选、不移动任务。

| 行为 | 部署前已证 | 部署后待验 | 类型 |
| --- | --- | --- | --- |
| 永久档案接口 | 本地 SQLite、分页、打包态 HTTP | 实际部署产物含新 API 且能读取现场档案 | automated_script |
| 系统语音 | 浏览器音色发现、过时取消、失败分支 | 真实系统音频输出、用户激活和听感 | guided_manual |
| BYOK 与第三方语音 | 模拟凭据库、协议、音频保存与恢复 | 用户 OS 凭据库授权、实际账户模型权限/地域、真实语音与重启 | guided_manual |
| agent 等待误报 | 状态机、真实 server/hook 集成 | 真实 harness 的 command/subagent 证据充分性及最终模型判断 | guided_manual |

| verificationId | 类型 | 资产目录末段 | cleanup |
| --- | --- | --- | --- |
| `e80b5f80-f50d-40e3-81bf-124edd13f13b` | automated_script：部署后的永久档案 API 和全量未读统计可以读取 | 同 verificationId | automatic |
| `0b7a1f36-5619-4472-a731-2efe8b9cf980` | guided_manual：系统语音按所选语言播放 | 同 verificationId | automatic |
| `3d1f0c14-84af-4a2f-9f3b-18ecbebe3c08` | guided_manual：真实 BYOK 与音频重启持久化 | 同 verificationId | automatic |
| `301e10e1-db63-442c-81e5-dccdd54c45d7` | guided_manual：真实 agent 等待/完成判断 | 同 verificationId | automatic |

资产根目录为 `~/.cline/kanban/verifications/`，没有任何脚本指向 task worktree；自动入口为 `run.cjs`。在旧运行实例 dry-run 得到受控 HTTP 404 失败（旧版没有该 API），无 crash/超时/残留，满足登记检查；它不代表新版本已部署。`verification list` 自查返回 `ok:true, count:4`。正常 deployment record 后预计挂载 1 个自动、3 个人工引导项。未添加临时 repo instrumentation。

兜底清理（不在本次执行）：

```bash
kanban verification cleanup --verification-id e80b5f80-f50d-40e3-81bf-124edd13f13b
kanban verification cleanup --verification-id 0b7a1f36-5619-4472-a731-2efe8b9cf980
kanban verification cleanup --verification-id 3d1f0c14-84af-4a2f-9f3b-18ecbebe3c08
kanban verification cleanup --verification-id 301e10e1-db63-442c-81e5-dccdd54c45d7
rg 'KANBAN-VERIFICATION-SCOPED:' src web-ui/src
```

功能、留档格式、位置与备份说明见同目录 `notification-intelligence-and-permanent-archive.md`。

## RVF 恢复与修复（2026-09-22）

系统重启前的外部审查未形成有效结果；在同一 RVF run 中保留原日志后重新派发，两路独立审查完成并通过结果协议校验。8 条意见合并为 7 个问题，全部经隔离 attempt 验证、最小修复并合回，无升级或未采纳问题：

- 旧 JSON 导入先检查 SQLite 成功标记；未迁移的损坏文件保留原样并诊断，避免阻断新档案和其它工作区，可修复原文件后重试。
- 客户端领取 RPC 失败释放本地去重标记，允许后续事件重放；领取成功及后续声音失败均不重新领取或自动重复付费。
- WebSocket 先完成核心订阅注册，通知档案重放采用 best-effort；档案失败或慢查询不再阻断工作区状态推送。
- 评估异常进入持久 `assessment_failed` 状态并保留面板记录；短时写入故障只补写失败状态，避免每 5 秒再次提醒或调用模型。若磁盘持续不可写且进程退出，内存去重不能跨该窗口保证 exactly-once。
- 桌面通知正文恢复工作区、任务标题和摘要，语音仍只使用摘要。
- 音频恢复增加 `(event_type, candidate_id)` 覆盖索引；隔离 100,100 事件微基准中查询中位值从 4.204 ms 降为 0.0142 ms。它消除无关事件扫描，匹配的音频事件仍随业务增长。
- 历史页等待全量已读/清空成功后刷新当前列表及打开的详情；失败显示错误并保留状态。

每项均有修复前失败、修复后通过的回归或查询计划证据。最终合并验证由 `validation_result_cache.py` 写入同 run 的持久证据，命令与结果以该 run 的 `artifacts/handoff.md` 为准：

`~/.rvf/user-local-data/run-logs/runs/rvf-20260921T232409Z-agentic-initiation-start-5618538e/`

重启后此前 `/tmp/8dc89-*` 日志已丢失；前述历史结果保留为当时观察记录，不能作为此次验证的 cache 证据。本次未提交、未部署。`.serena/project.yml` 为工具自动配置变化，不属于实现或修复范围，不应一起提交。

部署后验证 reconcile 保留原四个 ID，仅更新 `301e10e1-db63-442c-81e5-dccdd54c45d7` 的凭据异常不重复提醒断言；其它修复已由自动化回归覆盖，没有新增重复定义。自动脚本未变，不额外运行现场测试；仍需部署后执行原定义。

## 设置保存与导航修复（2026-09-22，原实现 land 后）

通知 Provider、密钥替换/删除、AI/语音参数和浏览器本机音色接入 Settings 的统一草稿与底部 Save。Cancel 或关闭丢弃草稿；切换 Provider 保留各项草稿。编辑器默认选择已绑定的 Provider，直接展示已保存名称、ID、凭据来源、配置状态及不可用原因；API Key 不回显。试听不隐式保存，有草稿时须先保存。每次打开重置导航到 General 和滚动顶部；显式 shortcuts 入口仍保留原定位逻辑。

保存复用现有接口，不具备跨配置存储与系统钥匙串的全局事务。失败时明确保留草稿并提示部分更改可能已保存；即使通知部分已成功，外层 Save 失败后也仍能重试。

验证结果：

- 根 TypeScript、Web TypeScript 与 Web 生产构建通过。
- Web 全量 174 个测试文件 / 1,706 项通过；其中设置页 13 项，覆盖统一保存多个 Provider、取消、密钥草稿保留、失败重试、浏览器音色保存边界、试听不保存及导航重开。
- 真实 Chromium 挂载生产 Settings 组件及样式，tRPC 请求由隔离 fixture 拦截：首次打开/重开 General 高亮和 scrollTop=0、点击 Notifications 后目标实际滚入顶部、已保存凭据状态、取消不写入、唯一 Save 写入及再次打开回显全部通过。没有修改现场配置或钥匙串，没有付费 API 请求。
- 改动文件 Biome 与 `git diff --check` 通过。此次未提交、未部署。

部署后验证 reconcile：

| 行为 | 部署前已证 | 部署后待验 | 处理 |
| --- | --- | --- | --- |
| 保存、取消、重试、导航与凭据状态显示 | 组件回归 + 真实 Chromium | 无新增现场依赖 | 不新增验证 |
| 系统语音 | 保存和试听触发边界 | 真实设备输出与语言 | 更新原 `0b7a1f36-5619-4472-a731-2efe8b9cf980` 步骤为 Save → 重开 → 试听 |
| BYOK 语音 | 草稿、状态显示与提交调用 | 真实 OS 授权、账户权限和音频 | 更新原 `3d1f0c14-84af-4a2f-9f3b-18ecbebe3c08` 的统一保存、回显和延迟删除步骤 |

两条均保持 guided_manual、automatic cleanup，资产目录仍为上文同 ID 目录；自动脚本未变，无新增 dry-run。`verification list` 自查 `ok:true, count:4`，仍为 1 个自动与 3 个人工引导，不运行、不勾选现场验证。兜底清理沿用上文同 ID 的 `kanban verification cleanup` 命令；未添加 repo instrumentation。


### 本轮设置修复的 RVF

run：`~/.rvf/user-local-data/run-logs/runs/rvf-20260922T122340Z-agentic-initiation-start-f66244a9/`。
两路外部审查完成，1 条意见合并为 RVF-001。validate/fix 子代理在独立 attempt 中复现「误点添加 Provider 后，统一保存其它设置也落盘占位 profile」，移除新增时强制标脏，保留编辑或绑定后的保存行为。新增四种回归情形，修复前 1 失败 / 16 通过，修复后 17/17 通过，Web 类型检查及 Biome 通过；patch 已经工具合回，无 scope 扩展。

此修复由自动化覆盖；部署后验证 reconcile 不需要新增或改写现场引导，保持原四个 ID。最终合并版本的验证命令、结果与缓存证据以本 run 的 `artifacts/handoff.md` 及 `artifacts/validation-records.json` 为准。本轮未提交、未部署。

## 2026-09-22 部署后无语音的独立复核与防复发修复

本节记录现场复核时的状态，不代表故障已在线上恢复。主 agent 与独立 SubAgent 分别查证：

- 部署标记为 `e3ffbbc44343bb3bcb0eb5ec46f13b3d1246eedf`；服务 PID `10639` 使用 Node `v24.12.0`。只读查询 `notificationIntelligence.listArchive` 返回 HTTP 500，原生 `better_sqlite3.node` 的编译 ABI 为 `127`，运行时要求 `137`。
- 永久档案目录 `~/.cline/kanban/notification-lifecycle-archive/` 为空；运行日志反复报告 `notification-archive-incomplete`。旧 `workspaces/cline-kanban/notifications.json` 有 300 条，最后一条为 2026-09-16 16:11:00（UTC+8），无任务 `8dc89`。不能据此还原用户所指单次通知的完整过滤和播放状态，也不能事后补回未落盘证据。
- 当前保存配置为 `speechMode=chime`、`speechProvider=browser`、`notificationSpeechBinding=null`、`assessmentEnabled=false`；这只证明当前落盘状态，不能证明用户此前的保存操作失败。
- 留档异常走 `publishUnarchived`，消息没有 `candidateId`，前端因此仅保留基础提示音，并继续受通知权限、前台可见性和声音开关限制。这是既有降级策略，不绕过候选领取/留档调用第三方 TTS。
- `9f073e97` 仅修复设置保存、凭据展示与导航，未修复此次原生模块兼容问题。

防复发修改：新增 `scripts/verify-notification-archive-native-runtime.mjs`，在内存 SQLite 中实际创建表、写入、读取并校验；通过 `prebuild` 在清理旧产物之前阻止不匹配的构建。本地部署 skill 另要求用**实际启动服务的 Node** 再运行预检，并统一安装、构建、启动的 Node；只检查构建 Node 不能覆盖跨版本启动。部署后档案 API 检查失败即不算部署成功。

本轮验证：

- `npm run prebuild`：Node 22.22.3 / ABI 127 通过。
- Node 24.12.0 执行同一脚本：按预期非零退出，明确报告 ABI 不匹配和 rebuild 操作建议。
- 固定 Node 24 的 PATH 执行 `npm run build`：在 `prebuild` 阶段拒绝；既有 `dist/cli.js` SHA-256 未变，没有执行 clean。
- `npm run test:guarded -- --project precommit-safe test/runtime/notification-lifecycle-archive.test.ts`：4/4 通过，包含测试安全策略与仓库 mutation canary。

部署后验证 reconcile：

| 行为 | 部署前已证 | 部署后待验 | 处理 |
| --- | --- | --- | --- |
| 原生 SQLite 与构建 Node 匹配 | 内存读写成功、ABI 不匹配阻止清理旧产物 | 实际服务启动 Node 与依赖一致，档案 API 可读 | 复用 `e80b5f80-f50d-40e3-81bf-124edd13f13b` |
| 基础提示音 / 摘要语音选择 | 本轮未修改投递或配置语义 | 原系统语音与 BYOK 验证继续适用 | 不新增条目 |

`verification list` 自查仍为 `ok:true, count:4`，保持原 1 个 automated / 3 个 guided 定义及资产，不变更脚本、不重复注册；因此无新增 dry-run。后续正常 deployment record 后沿用原定义。自动资产位于 `~/.cline/kanban/verifications/e80b5f80-f50d-40e3-81bf-124edd13f13b/`，cleanup 为 automatic，兜底清理命令仍为 `kanban verification cleanup --verification-id e80b5f80-f50d-40e3-81bf-124edd13f13b`；无 repo instrumentation。

此轮修改未提交、未部署；未重建线上 checkout 的依赖，也未改变用户语音配置。线上故障仍需在部署时按实际服务 Node 重建依赖并完成档案 API 验证，不能把新增预检等同于线上修复完成。

## 语言模型与 TTS 设置分组（2026-09-24 收尾）

Settings → Notifications 现在有两个独立分组：

- 「语言模型」包含 OpenAI 兼容 Provider 凭据、任务起名与通知判断/摘要用途、AI 判断开关及延期兜底。
- 「语音合成 TTS」包含 DeepInfra/阿里百炼凭据、声音模式、音色与播放参数；浏览器系统语音无需创建 Provider。

两组分别选择、添加和编辑 Provider，新增配置使用所属组协议；共享摘要/播报语言位于两组上方。底部统一 Save、Cancel、凭据来源和存储机制沿用既有实现。新增但未编辑/绑定的 Provider 不会落盘，保留上一轮 RVF 修复。

部署前验证：设置页 19 项回归覆盖分组筛选、独立编辑/密钥、用途归属、唯一表单 ID、空状态和统一保存；Web 全量 174 文件 / 1,712 项通过，根与 Web 类型检查、Biome 和 diff 检查通过。中断前已完成 Web 生产构建，以及真实 Chromium 挂载生产 Settings 组件的交互验证：两组独立选择与编辑、阿里地域字段、统一 Save 均通过，并检查了截图；API 由隔离 fixture 拦截，未修改现场凭据、未发出付费请求。

恢复时 `/tmp` 日志已清空；重新运行的类型检查、Web 全量测试与登记自查日志保存在 `~/.cline/validation-evidence/8dc89/provider-settings-separation/`。中断前的构建与浏览器结果以上述会话中的工具输出为证，没有把已丢失的临时截图当作持久资产。

部署后验证 reconcile：

| 行为 | 部署前已证 | 部署后待验 | 处理 |
| --- | --- | --- | --- |
| 分组、独立选择/草稿、用途筛选及统一保存 | 回归测试与真实 Chromium | 无新增现场依赖 | 不新增验证 |
| 系统语音与第三方 BYOK | 界面操作和请求边界 | 原有真实设备输出、账户权限与 OS 凭据授权 | 原两条引导更新至「语音合成 TTS」入口 |

已原位更新 `0b7a1f36-5619-4472-a731-2efe8b9cf980`（系统语音）和 `3d1f0c14-84af-4a2f-9f3b-18ecbebe3c08`（真实 BYOK）步骤，仍为 guided_manual / automatic cleanup；资产目录分别为 `~/.cline/kanban/verifications/<verificationId>/`。恢复后 `verification list` 确認 `ok:true, count:4` 且步骤正确；没有重复登记。自动脚本未改，无新增 dry-run；部署记录仍沿用原 1 个自动、3 个人工引导项。未添加 instrumentation，兜底清理沿用上文同 ID 的 `kanban verification cleanup --verification-id <id>` 命令。本轮未提交、未部署。

### 本轮分组修改的 RVF（2026-09-24）

run：`~/.rvf/user-local-data/run-logs/runs/rvf-20260924T060300Z-agentic-initiation-start-cf68933e/`。

预审先单向吸收 local main `24591cd67c0494232f675e1a79350633594eb5d4`，五文件 WIP 完整恢复，无冲突、handback 或 push。实际两路外部实现审查完成并通过结果协议校验，1 条意见合并为 RVF-001：共享语言下拉移出 fieldset 后漏掉保存/试听禁用边界。独立 validate/fix attempt 复现后补回 `disabled={busy || disabled}`；两项回归修复前失败、修复后通过，设置页 21 项通过，补丁已工具合回，无 scope 扩展。

该禁用行为由自动化覆盖，部署后验证 reconcile 无需再改现场定义；仍保留原四个 ID 与此前更新的 TTS 入口文案。最终合并版本、吸收 base 后的验证以本 run 的 `artifacts/handoff.md` 和 `artifacts/validation-records.json` 为准。本次未提交、未部署。
