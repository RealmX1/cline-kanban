# Codex hooks 信任刷新修复的验证记录

Task：`cline-kanban/7494b`。源码基线：`0d3d914c`。本次只交付源码、测试和调查报告；未提交、未同步 base、未部署运行实例。

## 根因与实现

真实 Codex CLI 0.164.0 的隔离探针验证了四个连续状态：同一份共享 hooks 文件在原目录确认后，复制配置到另一目录仍为 `untrusted`；映射文件来源键后为 `trusted`；按旧逻辑再次刷新配置，又变回 `untrusted`。同一文件在两个位置的定义哈希相同。另行核对 Kanban 会话旗标 hooks 的现有哈希算法，与原生结果一致。

修复在配置桥接层保留目标 `hooks.state`，补齐共享文件和复制配置的来源键映射，语义无变化时跳过文件替换。保留原生哈希和禁用状态，不引入全局信任绕过。主配置、外置 profile 和旧内联 profile 采用同一逻辑。

## 部署前自动验证

| 行为 | 证据 |
| --- | --- |
| 原目录信任映射到专用目录 | 真实 CLI `hooks/list`，共享 JSON 与内联 hooks 均为 `trusted` |
| 专用目录新确认跨连续刷新保留 | 真实 CLI 连续启动检查；来源配置没有新增确认，目标确认仍在 |
| 新增和真实修改仍需审查 | 原生分别报告 `untrusted` 与 `modified` |
| 禁用与显式未信任继续有效 | 原生禁用状态及单元回归，不为目标空记录补上来源哈希 |
| profile、模型更新和原文件保护 | 主/外置/内联 profile 单测，来源文件字节不变，其他配置仍刷新 |
| 无变化不写文件 | 连续并发准备后保留原生格式和注释 |
| 写前出现并发确认 | 确定性故障注入：补读成功；连续三次冲突保留原文件、清除待写文件，后续启动可恢复 |
| 会话启动、续接与既有迁移 | 原有 adapter、session manager、原生存储迁移测试 |

通过 5 个相关测试文件中的 281 个不同用例：最新一轮普通测试 276 个，原生集成测试另 5 个。测试经过 guarded runner 的静态策略和调用仓库 mutation canary；真实 CLI 仅使用隔离 HOME / fixture，不使用付费模型。根项目和 Web UI 类型检查、改动代码的 Biome 检查均通过。

首轮新增幂等断言暴露 TOML 解析表与合并对象原型不同，已改为统一 TOML 表语义后比较，并通过复跑。原生迁移测试最初被宿主继承的 `CODEX_SQLITE_HOME` 触发归属保护，清除测试父环境的两个 Codex 目录变量后通过；没有放宽迁移门禁。

复跑入口如下；本机使用 Node 24，是为了匹配共享依赖中的原生模块 ABI，并未重建共享依赖。

```sh
env -u CODEX_HOME -u CODEX_SQLITE_HOME \
  PATH=/Users/bominzhang/.nvm/versions/node/v24.12.0/bin:$PATH \
  KANBAN_CODEX_NATIVE_STORAGE_ISOLATION_SMOKE_BINARY=/opt/homebrew/bin/codex \
  npm run test:guarded -- --project runtime-integration \
  test/integration/codex-hook-trust-configuration-refresh-native-cli.integration.test.ts \
  test/integration/codex-conversation-storage-native-cli.integration.test.ts

env -u CODEX_HOME -u CODEX_SQLITE_HOME \
  PATH=/Users/bominzhang/.nvm/versions/node/v24.12.0/bin:$PATH \
  npm run test:guarded -- --project precommit-safe \
  test/runtime/terminal/codex-conversation-storage-home.test.ts \
  test/runtime/terminal/session-manager-codex-conversation-storage.test.ts \
  test/runtime/terminal/agent-session-adapters.test.ts
```

## RVF-001：软链 home 的原生来源身份

在隔离 HOME 和统一 fixture 中，用真实 Codex CLI 0.164.0 补测四种路径布局。修复前普通目录对照通过；来源 home 为软链、来源父目录为软链、专用目录父路径为软链时，原目录已确认的共享 JSON 与内联 hooks 均在 prepare 后失去信任。原生 `hooks/list` 的来源键使用 `realpath(home)`，词法路径不能替代该身份。

最小修复只在来源映射中对来源和目标 home 取真实路径，再附加已共享或复制的文件名；不对共享文件本身取真实路径，也不放宽现有账号绑定、共享入口或存储写入门禁。普通测试的默认 fixture 同时规范化根路径，避免 macOS `/var` 别名生成非原生的伪造来源键；软链布局由回归显式构造。

新增六项主配置／外置 profile 单元回归，兼验旧内联 profile、来源禁用、非原生词法别名和其他文件不被迁移、原文件与共享链接保持原样，以及切换来源仍被账号门禁拒绝。原生测试增加三种软链布局，并对全部四种布局检查来源禁用继承、本目录确认跨刷新保留、新增为 `untrusted`、定义修改为 `modified`。

最新复跑通过上述五个测试文件共 290 个用例（普通测试 282 个，真实原生集成 8 个），经过 guarded runner 的静态策略与调用仓库 mutation canary。根项目和 Web UI 类型检查、三个改动代码文件的 Biome 检查通过。测试父环境清除了 `CODEX_HOME`／`CODEX_SQLITE_HOME`，仅补齐 attempt 的依赖入口软链，没有安装或重建共享依赖，也没有部署实例。

## RVF-002：尚未解决的最终提交窗口

该问题经真实 Codex CLI 0.164.0 验证属实，未以“缩小窗口”或文档说明替代修复：在产品最终 `rename` 前，通过独立原生 app-server 的 `config/batchWrite` 成功保存禁用，`hooks/list` 已报告 `enabled=false`；随后配置准备成功返回，同一原生查询却变回 `enabled=true`。原生写入期间 Kanban 目录锁仍被持有，说明这把锁不约束原生 writer。

原生 `expectedVersion` 也不能直接作为跨独立进程的 CAS：20 轮两个 app-server 对同一隔离配置、同版本并发更新不同记录，20 轮双方均返回成功，其中 19 轮丢失已确认的一方修改。该实验不代表任意原生配置写入都必然丢失，但足以否定“改用这个 RPC 就消除提交竞态”的假设。未激活 profile 的写入另被原生接口以 `configLayerReadonly` 拒绝。

证据在本轮 RVF 的 `artifacts/native-configuration-write-protocol/`：`rvf002-native-disable-before-snapshot-rename-probe.mts` 与对应 `probe-result.json`、`rvf002-independent-native-writers-probe.mjs` 与对应 `probe-result.json`。运行目录为 `/Users/bominzhang/.rvf/user-local-data/run-logs/runs/rvf-review-start-b220f3611b25c4cd/`。全部实验使用隔离 HOME、合成配置和无模型请求，没有改真实用户配置。

现有宿主让 TUI 直连各自的 app-server Unix socket，且部分 profile 启动走旁路，没有现成的统一配置写入协调点。消除该缺口需要选择写入边界：延后有写入者时的刷新，或分离原生可写配置与生成快照；这会改变配置时效或扩大启动/兼容/迁移范围。第三种选择是明确保留当前乐观窗口，但不能因此标记问题为已修复。本轮状态为一项已修复、一项 `elevated` 待选边界；尚不能宣称所有信任覆盖情形均已解决。

## 部署后验证分析与注册

按 `cline-kanban-post-deploy-verification-authoring` 分析如下：

| 行为 | 部署前已证 | 部署后待验 | 类型 |
| --- | --- | --- | --- |
| 映射、合并、禁用、真实变更门禁、冲突重试 | 已由隔离真实 CLI 与确定性测试覆盖 | 无额外定义 | 不重复注册 |
| 真实实例调用配置刷新后保留用户已有信任 | 测试证明函数及启动接线行为 | 用户实际配置在自然新 Task 启动后的保留情况 | `automated_script` |
| 可视化目录统计和建议 | 已核对现存文件与源码 | 本轮没有改动运行行为 | 无需注册 |

已注册一项自动验证，零项人工验证：

- `verificationId`：`aa7d1fea-cbad-49cc-b577-993361040ef4`。
- 断言：真实实例刷新配置后，共享 hooks 的既有信任与禁用记录仍被继承并保留。
- `assetsDir`：`~/.cline/kanban/verifications/aa7d1fea-cbad-49cc-b577-993361040ef4/`。
- `cleanup.mode=automatic`；脚本、基线和观察历史全部在资产目录内，没有仓库插桩。
- 自查 `verification list --task-id 7494b` 返回 `count=1`。部署 record 后预计挂载 `automated=1 / guided=0`。

脚本仅读取真实实例写出的来源标记、主配置与共享 hooks 文件。第一次采样把已有目标记录及来源可继承记录保存为基线；后续调用等 `canonical-user-codex-home.json` 的修改时间推进，再核对记录保留情况。真实定义改变时保存旧基线到追加历史，再建立新样本；来源目录变更或信息不完整时返回待验，保留未知和重验条件。另以隔离 HOME 自检了基线建立、未刷新等待、信任丢失检测、后续恢复及旧失败历史保留，均通过；自检未改真实配置，隔离目录已回收。

RVF-001 后按同一 verificationId reconcile：观察脚本按原生 home 的真实路径匹配信任键，保留词法来源绑定，补记来源/目标真实身份。旧观察版本的基线先追加存入历史，再建立新基线；不会把无法核对的旧路径身份冒充通过。该观察只验证自然刷新后的持久状态，不能代替 RVF-002 的并发事务证明，后者仍未解决。

在旧实例上 dry-run 的结果是**退出 1：已捕获基线，等待之后的自然配置刷新**。没有崩溃、超时或额外进程，没有创建 Task 或改用户配置。该结果不是验证通过；真正通过须观察到后续刷新且信任记录保留。状态文件让核验在机器或进程重启后继续，不依赖本 Task worktree。

手动重跑自动脚本的入口如下（不是要求用户手动操作 UI）：

```sh
bash ~/.cline/kanban/verifications/aa7d1fea-cbad-49cc-b577-993361040ef4/run.sh
```

兜底清理：

```sh
kanban verification cleanup --verification-id aa7d1fea-cbad-49cc-b577-993361040ef4
```

没有 `KANBAN-VERIFICATION-SCOPED` 仓库插桩，因此无需移除插桩标签。调查清单和本报告是交付物，不属于验证资产的自动清理范围。
