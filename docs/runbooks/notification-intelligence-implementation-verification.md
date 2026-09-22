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
