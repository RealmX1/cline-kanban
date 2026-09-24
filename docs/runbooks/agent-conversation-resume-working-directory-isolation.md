# Agent 会话恢复的工作目录隔离

## 兼容性契约与事故原因

Kanban 的隐式「继续最近会话」应在任务的执行目录内选择。已观测到原生会话 ID 时仍优先按 ID；共用同一 cwd 且无可靠 ID 时，沿用既有歧义拒绝规则。明确选中的跨目录会话播种 / fork 是独立意图，不应被隐式范围限制拦截。

2026-09-24 调查确认：Codex 0.156.0 起 `worktrees` 成为默认启用的稳定特性，`resume --last` / `fork --last` 的候选目录可能扩展到同仓库关联的 worktree。它不是任意仓库的全局最新会话。task 7a66f 缺少原生 ID，恢复落到 cwd-latest，于是选中了兄弟任务 5a9d1 的更新会话。

`Working directory · resume` 是 Codex 选定会话之后的执行目录选择。选择 Current 只改变执行 cwd，并不会重新选择当前目录的会话；所以随后仍可能遇到被另一个进程持有的原生会话锁。不要删除锁或更改用户全局偏好来掩盖寻址问题。

上游依据：[0.156.0 release](https://github.com/openai/codex/releases/tag/rust-v0.156.0)、[worktrees 稳定化 PR](https://github.com/openai/codex/pull/44870)、[0.156.1 的 repository_cwd_filter](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/tui/src/resume_picker.rs)、[latest_session_lookup_params](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/tui/src/lib.rs)。

## 实现边界

- `agent-session-adapters.ts` 是 PTY 的统一启动入口，覆盖自动聚焦恢复、手动重启、垃圾桶恢复、进程退出 / 回收后重开和 By-the-way cwd-latest fork。
- Codex 仅在隐式最近会话路径注入 `-C <task cwd>`，以及 **resume/fork 子命令之后**的 `-c features.worktrees=false`。真实 0.156.1 PTY 实验中，仅放在根参数区的配置仍选中 B；放在子命令之后才正确选中 A。参数排列是回归契约，不能只检查 argv 中「存在」该字符串。
- cwd-latest 遇到 `--all`、指向其它目录的 `-C/--cd`、显式启用 worktrees、覆盖整个 features 表、参数终止符 `--` 时，在生成启动命令阶段报清楚冲突。检查重复参数、短写和等号形式；等价真实目录可接受。prompt 在校验后追加，不把正文误当开关。
- 新会话、明确原生 ID 恢复、明确来源 ID fork 不增加该特性覆盖。不改用户 `config.toml`，不增 public API / UI 设置。
- ACP 续跑及 OMP 通道切换：`session/list({cwd})` 只是请求条件，返回项仍逐条通过 `realpath` 核对，遍历所有页后按更新时间选最近项。缺失、相对、消失或不匹配 cwd 均排除；没有匹配就报错，不加载兄弟任务、不静默创建新会话。重复分页游标报错；加载失败清理重播守卫与映射。

| Harness / 通道 | 本次处理 | 实测或边界 |
| --- | --- | --- |
| Codex PTY | 修复两种 `--last`，保留显式 ID | 0.156.1 真实 PTY：A resume、A fork、明确 B fork 均通过，fork 元数据父 ID 正确 |
| Claude Code | 保留原生 `--continue` / `--resume ID` / `--fork-session` | adapter / 原生 ID 优先与共用目录歧义测试覆盖；原生 smoke 未证实：隔离 PTY 在引导 / trust 阶段退出，headless 本地假 provider 运行 25 秒未返回，不能记为通过 |
| Kimi PTY | 保留按工作目录的 `--continue` | 0.38.0 真实 CLI：先创建 A，再创建 B，再 continue A，实际 ID 为 A/B/A；无模型请求 |
| OMP PTY | 保留原生 `--continue` | 安装源码的 `SessionManager.continueRecent` 实测：B breadcrumb 存在且 B 目录仍在时，A 选择 A；显式路径仍选 B |
| OMP ACP | 独立目录校验与分页 | 真实 `omp acp` 经修改后的 Kanban runtime 完成 list/load，返回 A 的原生 ID |
| Cursor | 保留已有 `--continue` / `--resume ID` | adapter 回归；未做原生 Cursor smoke |
| DeepSeek Harness | 适用性审计 | 本仓库 catalog 没有 DSH agent；DeepSeek 模型 provider 不等于 harness。独立 dsh 的 CLI 把 app 参数交给 profile，不能借用 Codex 的 flag。未新增接入或修改另一仓库 |

OMP 的 terminal breadcrumb 有刻意保留的原生例外：同目录旧 breadcrumb 可优先于最新会话；旧 cwd 已消失、目标目录无会话时会将旧会话迁移过来。后一分支已用隔离目录实测确认。不能声称 PTY 的新终端总会忽略 breadcrumb，也不能声称所有 harness 均有 Kanban 级的绝对目录隔离。

## 验证与重跑

部署前：12 个测试文件、212 项 guarded 回归通过；另有 1 项真实 Codex integration（内部验证三条选择路径）通过；根与 Web UI typecheck、改动文件 Biome 检查通过。覆盖 adapter 参数、ACP 分页 / 目录 / 失败清理，以及会话寻址、重启、回收续跑和历史重播时间戳守卫。

真实 Codex smoke 是显式启用的 integration test；无本地二进制时明确 skip，不冒充原生通过：

```bash
KANBAN_CODEX_NATIVE_DIRECTORY_SMOKE_BINARY="$(command -v codex)" \
  npm run test:guarded -- --project runtime-integration \
  test/runtime/terminal/codex-native-working-directory-resume.integration.test.ts
```

它使用仓库标准 Git 隔离 fixture 建两个 linked worktree，隔离 HOME / CODEX_HOME，构造 A 较早、B 较新的历史。只重放历史，不发 prompt；使用假凭据，模型 endpoint 指向 loopback。检查终端实际重放的源会话标记及 fork 的 `forked_from_id`，结束清理进程和临时目录。运行该项不会修改真实任务或用户 Codex 配置。

## 后备方案：仅留档，不提前建设

若原生范围语义再次漂移，或 OMP 的迁移 / breadcrumb 行为实际导致 Kanban 串任务，再评估统一由 Kanban 枚举原生会话、核对实际 cwd、选择最新项并固定原生 ID / 路径。代价是拥有各家会话存储格式、排序、分页、迁移和版本兼容性；收益是宿主独立控制选择。当前采用已批准的针对性修复，不新增通用解析框架。对应代码已标 `EXPERIMENT_NODE:`。

## 部署后检查

| 行为 | 部署前已证 | 部署后待验 | 类型 |
| --- | --- | --- | --- |
| 真实 Codex 范围选择 | 隔离原生 PTY + adapter 回归 | 运行实例确实发出子命令级隔离参数 | automated_script |
| ACP 候选校验 / 分页 / load | fake 协议异常回归 + 真实 OMP ACP list/load | 无额外独占部署断言 | 无需重复注册 |

注册任务 `9d24c`，verificationId `e0c30bbb-5a25-420c-8b62-50d1121962b3`，类型 `automated_script`，资产目录 `~/.cline/kanban/verifications/e0c30bbb-5a25-420c-8b62-50d1121962b3/`，`cleanup.mode=automatic`。部署 record 后预计挂载 1 条自动检查、0 条人工检查。

脚本读取 `KANBAN_RUNTIME_HOST/PORT`，经 CLI 查询真实实例的任务 PID，再只读观察 Codex argv。没有可观察的 cwd-latest 进程则明确非零退出；不对用户任务执行重启或造新会话。该检查只证明生产启动参数，原生源 ID 的行为证据来自上述隔离测试。

自查 `verification list` 返回 `ok=true, count=1`，kind、label、入口和资产目录均与定义一致。

旧实例 dry-run 按预期 FAIL：任务 c2c84 和 ai-analysis 的 7a66f 尚未携带隔离参数。脚本正常结束，无超时、无任务写入、无临时目录残留。未部署，不把此 FAIL 写成生产修复已通过。

兜底清理（无 repo 插桩）：

```bash
kanban verification cleanup --verification-id e0c30bbb-5a25-420c-8b62-50d1121962b3
```
