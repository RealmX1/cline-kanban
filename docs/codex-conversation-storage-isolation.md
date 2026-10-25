# Codex 会话存储隔离与历史续接

全新上下文的看板 Codex Task 使用 `~/.cline/kanban/codex-conversation-storage-home`，与用户原来的 `CODEX_HOME` 分开保存会话、SQLite 和运行状态。旧会话先保持原目录；只有显式执行迁移，且整张 Task 及原生会话族都停止后，才会切换绑定。

## 问题与证据边界

2026-10-23 在本机 Codex CLI 0.164.0、ChatGPT App 26.1016.62342 上调查：运行时和当前 Task 均未设置 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`，当前原生记录仍以 `codex-tui` 来源被 App 的本地统一目录收录。App 目录快照中有 627 条看板 worktree 路径记录。来源变量继承不是这次问题的已证根因；共享默认会话目录及 App 收录 CLI/vscode 历史，才是现场支持的分流方向。

这些证据说明本地统一列表收录，不能据此声称会话已注册或上传成 ChatGPT 云端对话。App 普通 Recents 的最终表现仍须在部署后观察。

官方支持 [`CODEX_HOME` / `CODEX_SQLITE_HOME`](https://learn.chatgpt.com/docs/config-file/environment-variables)。实现同时覆盖 `sqlite_home`，避免只隔离 JSONL、却继续把分页历史写入原库。迁移依赖 [app-server 原生读取和归档接口](https://learn.chatgpt.com/docs/app-server)，不直接修改 App 的目录数据库。

## 启动、配置与绑定

- 真实 workspace registry 显式启用隔离；裸 `TerminalSessionManager` 的默认值保持关闭，便于测试和非 workspace 调用。
- 全新上下文使用专用目录。显式复用、从旧会话分叉以及旧 Task 续接，先跟随来源目录；它们可以在之后停止时受控迁移。
- 主会话、侧会话、历史选择器、独立任务种子及 RVF 原生历史操作都传递存储目录。summary 的 `codexConversationStorageHomeDirectoryPath` 记录实际启动目录；原生转录路径能证明更近一次 fork 的实际目录时，使用该路径。正式迁移记录决定最终权威副本。
- 子进程清掉 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`，父进程不变。新目录同时设置 `CODEX_HOME`、`CODEX_SQLITE_HOME` 和 CLI `sqlite_home`；旧目录不重写其既有 SQLite 选择。
- 全新上下文开局准备时复制 `config.toml` 和现有 `*.config.toml`，保留模型、MCP、插件设置，把 SQLite 指到专用目录。主配置、外置及内联 profile 的指令、compact prompt、模型目录和 `agents.<role>.config_file` 等已知文件引用保留原解析基址；角色配置仍引用原文件，其内部相对路径继续由原文件位置解释。已运行进程不会因刷新快照而重启。
- 现有 `auth.json`、`.credentials.json`、`AGENTS.md`、`skills`、`plugins`、`rules`、`hooks.json`、`prompts`、`marketplaces` 用软链共享。原用户配置不被改写。共享登录入口意味着从专用目录执行登录操作可能更新同一账号文件；它不是独立账号。
- 配置刷新保留专用目录已保存的 `hooks.state`，并把共享 `hooks.json`、复制的主配置及外置 profile 的文件来源键映射到专用目录；旧内联 profile 同样处理。来源键沿用 Codex 的真实 home 路径，再附加文件名，因此 home 或父目录为软链时仍能匹配；不对共享文件本身取真实路径，账号绑定与共享入口校验仍使用原有规则。已有本目录记录优先，缺失项继承原目录记录，任一明确禁用继续有效。只映射已共享或复制的文件，不映射其他项目或插件身份，也不重新计算 `trusted_hash`；新增或修改的定义仍由 Codex 原生信任门禁审查。
- 语义相同的配置不重写，原生保存的格式和注释也保留。需要更新时，在现有目录锁内合并信任记录并原子替换；检测到写入前的并发变更会重读，最多三次。持续冲突或目标信任状态无法解析时保留现场并返回明确错误，下次启动可重试；不把坏配置覆盖为来源快照。
- 专用目录保存来源标记，拒绝混用第二个账号目录。显式 `cli_auth_credentials_store="keyring"` 暂不支持配置桥接，会拒绝新启动。系统 OAuth/keyring 的实际可用性仍由原生客户端决定。
- 配置可以共享软链；可写的会话、数据库、WAL 和 SHM 路径不允许软链逃逸回原库。

## 迁移与回退命令

以下命令均要求已部署包含该实现的运行实例。`--project-path` 指注册的主仓库，不能指 task worktree。

```bash
kanban codex-conversation-storage status --project-path <主仓库路径>
kanban codex-conversation-storage migrate-stopped --project-path <主仓库路径> --conversation-session-id <看板会话ID>
kanban codex-conversation-storage rollback-stopped --project-path <主仓库路径> --conversation-session-id <看板会话ID>
```

`--conversation-session-id` 是看板会话 ID，不是原生 UUID；省略时处理该 workspace 的所有已知 Codex 会话。主、侧会话可能有各自的看板会话 ID。写操作统一通过 runtime procedure，不由 CLI 直接改 board 或 summary。

| 状态 | 含义 |
| --- | --- |
| `active_deferred` | Task 的主/侧会话或共享原生身份仍活着，延后处理 |
| `eligible` | 运行时摘要显示已退出，仍须实际取得原生写锁并核验数据库 |
| `isolated` | 已绑定专用目录 |
| `migrated` | 原生历史校验完成，绑定已提交，来源已归档 |
| `rolled_back` | 已把专用库的最新历史恢复到原目录，并切回原绑定 |
| `refused` | 身份、归属、版本、数据冲突或环境无法安全确认，保留现场 |

命令输出 JSON；存在 `refused` 时退出码为 1，`active_deferred` 本身不算错误。`status` 是只读分类，不保证后续迁移必然成功。没有可靠原生 ID 的摘要不会靠 cwd-latest 猜测。

本实现不安装自动迁移定时器、不自动停止或重启 Task。用户在自然使用中停止对应会话后，再运行迁移命令。一次回复结束、等待 review 或输入框空闲都不算停止。

## 数据完整性与故障边界

迁移和回退目前仅允许 `codex-cli 0.164.0`。POSIX 使用 `python3` 的 `fcntl.flock`，锁定 Codex 原生 `thread-writer-locks/<UUID>.lock`；Windows 无法核验时拒绝历史迁移，但不影响新增会话隔离。

1. 运行时核对同 Task 所有会话的 liveness，再核对明确的 Task 归属。显式恢复个人来源会话、App 创建来源、早于 Task 的原生对话、cwd 不符或未知，均保留来源。
2. 遍历原生 `thread_spawn_edges`，整族取得看板操作锁和原生写锁；任何子会话仍写入都拒绝迁移。启动和原生辅助读取也遵守目录操作锁。
   Node 保留锁文件的 open file description，并把同一描述符交给 Python 取得 flock。辅助进程异常退出时，锁仍保持到在途操作收口；复制和绑定提交还要检查持锁 guard，不能在外层抛错后留下后台写入。
3. 先持久记录 `copy_started`，再备份和复制本会话的 JSONL 及选定数据库行：`state_5.sqlite`、`thread_history_1.sqlite`、`goals_1.sqlite`、`queue_1.sqlite`。从 SQLite 一致快照读取，包含 WAL，保留 UUID、回合和历史项，不复制无关任务的历史。版本和表结构不一致即拒绝。
4. 分页 fork 与同 ID 原生回退分片递归解析 `history_base`，严格核验分片身份、累计 ordinal 与 UTF-8 字节边界。只复制读取所需的 rollout 冻结前缀和 `thread_history_1.sqlite` 历史投影；祖先不纳入写锁拥有者或归档族，不携带祖先的 goals、queue 和运行调度状态。新依赖放在 `archived_sessions/kanban-history-base-read-dependencies/`，不进入普通历史选择。已有祖先前缀相同则复用，保留其后续历史；前缀冲突则拒绝覆盖。新读取依赖带有分阶段的来源凭据；父 Task 日后正式迁移时，只有目录、归档态、来源身份、冻结前缀与全部依赖历史均能匹配，且没有独立运行状态，才允许把只读副本晋升为拥有者。旧依赖文件随晋升移入迁移备份，避免同一分片重复发现。
5. 独立只读 app-server 验证 ID、转录位置和完整回合。以来源与目标的完整原生回合、历史项逐项比较，并核验原生结果覆盖整个 rollout lineage 的回合与项；不能拿局部线程行数代理完整历史。分页格式逐页核验；legacy 仅在明确不支持分页时回退到完整原生读取。超时、协议错误和中途分页失败均不算完整。
6. 原生 `thread/archive` 要自行取得原生写锁，不能在外部持锁时调用。交接后重新取得来源写锁，对比两边 JSONL 与选定数据库行；只有没有遗漏历史，才把整族的权威绑定提交到专用目录，root 记录最后写入。若发现交接期间新增历史，保留原绑定并尝试原生 unarchive 恢复原有可见性。
7. 重试只允许覆盖来源及首次备份能够解释的未提交副本。副本若有独有历史则拒绝覆盖；来源继续产生新历史后，停止写入即可安全重试。未提交副本在历史选择器中隐藏；两目录同 ID 却无迁移记录时，两者都不供猜选。
8. 回退先从专用库的当前 `state_5.sqlite.threads.rollout_path` 读取最新分片，把专用目录的最新历史复制回原库；原库若有独有新增记录则拒绝覆盖。原生 unarchive、重新持锁核验和整族绑定提交完成后，才重新认原目录。回退不启动模型回合。

lineage 迁移限制为最多 256 个分片、合计 512 MiB 与最多 100,000 个扫描条目；缺失、歧义、循环、边界错误或未验证的压缩分片均保留原绑定。普通 resume 在本次隔离 0.164 案例中原地追加；同 ID 的新分片通过真实 `thread/revert(beforeTurnId)` 后续聊验证，不能把固定的最初迁移路径当成当前路径。

原库记录通过原生归档保留，不物理删除。备份与迁移记录在 `~/.cline/kanban/codex-conversation-storage-migrations/`，以来源目录和 UUID 的 SHA256 命名；应随原用户目录和专用目录一并备份。不要为了重试删除原生锁文件、迁移记录或备份。

外置 `sqlite_home` / `CODEX_SQLITE_HOME` 的旧历史目前拒绝自动迁移，防止从错误数据库复制；旧会话仍可在原配置下继续。版本升级后也需先补兼容验证，再扩展历史迁移支持，不能单纯去掉版本闸门。

若迁移后在专用目录产生了新的原生子会话，当前自动回退会拒绝变化后的会话族，继续保留专用目录及全部历史；不能把只覆盖原会话族的回退当成全族恢复。

## 验证与部署边界

部署前自动测试覆盖配置桥接、旧目录续接、活体及侧会话门禁、原生整族锁、故障重试、归档交接竞态、分页完整性、回退新增历史和历史选择器的权威副本。真实 CLI 的 legacy/paginated 联调仅用隔离 HOME、合成认证和 `127.0.0.1` 模型响应，不触碰用户 Task，也不产生真实模型费用。

```bash
# 按本机已安装的原生依赖 ABI 选择 Node；本次共享依赖为 Node 24，不能为测试重建共享 node_modules。
KANBAN_CODEX_NATIVE_STORAGE_ISOLATION_SMOKE_BINARY=/opt/homebrew/bin/codex npm run test:guarded -- --project runtime-integration test/integration/codex-conversation-storage-native-cli.integration.test.ts test/integration/codex-conversation-storage-paginated-history-lineage.integration.test.ts
```

hooks 信任回归另由 `test/integration/codex-hook-trust-configuration-refresh-native-cli.integration.test.ts` 覆盖。
使用同一个原生 CLI 环境开关，通过 `hooks/list` 检查共享文件与内联 hooks 的信任继承、专用目录确认和禁用跨连续启动保留，以及新增/修改后的待审查状态；覆盖普通目录、来源 home 软链、来源父目录软链与专用目录父路径软链，不启动模型回合，不使用信任绕过参数。
从已隔离的看板 Codex 会话运行迁移测试时，先清除测试父进程继承的 `CODEX_HOME` / `CODEX_SQLITE_HOME`，避免它们覆盖 fixture 的目录归属。

只有部署后的真实实例能最终证明 CLI、实际进程环境和持久绑定已经接通。本 Task 注册了两项只读自动验证和一项 App Recents 引导观察；自动脚本只读取自然使用产生的样本，无样本时明确失败并保持待验，不为验证强停或迁移用户 Task。App 自动化访问被工具明确禁止，因此外部 App 视觉核对保留为人工兜底。

本次源码交付不等于已部署、真实历史已迁移或 App Recents 已验证。未迁移的活跃旧会话暂时仍可能出现在普通 Recents。
