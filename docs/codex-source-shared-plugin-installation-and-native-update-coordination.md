# Codex 同源插件安装与原生更新协调

新 writer 与原来源共同持有 `plugins` 和 `.tmp/marketplaces`。前者包含最终插件，后者包含原生 marketplace 安装树及 `.codex-marketplace-install.json`。只共享前者会让新进程把已有插件误判为需要重新安装：隔离复现中，同一 revision 的三个插件有效载荷完全相同，最终目录 inode 却全部变化，原生内容指纹随之变化。

本实现保留可变的原生安装树、真实更新和原生哈希算法，不建立活会话不可变分发，也不自动签回失效的批准。`60208` 已落地的定义／内容双哈希、禁用、撤销和原所有者实际采用门禁继续生效。

## 绑定与能力

`CodexConfigurationWriterBinding.schemaVersion` 保持 `1`；新增可选 `sourceSharedPluginInstallationDirectoriesBinding`，保存布局版本、两个容器的 canonical path、持久目录身份，以及实际 executable 的路径、文件身份、版本和观察时间。

共享安装默认按实际 binary 的隔离行为核验，不维护 Codex 版本白名单。版本仅作诊断，连 `--version` 暂不可用也不会否定实际能力。核验使用最终启动的 executable 文件身份及实际 PATH；在独立 HOME、CODEX_HOME、SQLite 和本地合成 Git marketplace 中验证升级、安装、原生 hook 指纹及双目录共享后的重复启动稳定性，不访问真实凭据、插件、外部模型或网络。

能力证据按 executable 文件身份、Git 依赖身份、平台和探测协议修订持久缓存；同进程并发及跨进程均只核验一次。旧绑定仍可读取，后续自然换代重新核验并采用新绑定。实际 binary 被替换后必须重新核验，不能只比较版本字符串。HOME 的合法路径别名使用同一物理证据目录；证据目录自身被替换为软链时继续拒绝。

确证命令、响应或布局不兼容，或相同内容仍反复重装时，记录 `unsupported_native_capability` 并使用完整独立的插件与 marketplace 安装目录；可复制既有缓存，但不能混用共享插件与私有安装记录。暂时超时或缺证保持 `retry_pending`：每轮最多 30 秒，同一次启动自动等待重试，每个窗口最多三次、间隔至少 30 秒；连续三次失败后冷却 15 分钟，已有配置补扫器沿用原 PATH 与工作目录开启下一有界窗口，累计次数及逐次原件不重置。程序或依赖身份变化仍独立重新核验。Stop 在等待后的再次核验前仍须检查。进程回执、原控制器退出和原生进程退出分别核验，未退出或查询失败不能重复启动探测；PID 已知时只有系统明确报告进程不存在才继续，PID 回执缺失时必须完整核验进程表。

旧 `unverified_native_capability` 记录保持历史语义。目录归属异常及已部分执行的真实安装继续经过原有安全与补证门禁，不能通过不兼容回退绕过。实施、版本回归及历史失败对照见 [默认能力核验记录](research/codex-plugin-installation-default-capability-verification.md)。

来源的两个容器须共同存在并通过归属核验后才建立桥接。writer 自己的 `.tmp` 必须为普通目录，只共享其 `marketplaces` 子目录。原顶层 `marketplaces` 兼容桥继续保留。来源首次已有合法软链时绑定其实际目标，之后路径或持久身份变化都会拒绝沿用旧绑定。卷观察在配置 store 锁外预取，锁内只复核现有观察与目录事实。

旧绑定缺少新字段仍可被原进程接管，不热改挂载、不强制重启。自然换代才采用新布局；原生 session ID、历史目录、写锁和 SQLite 归属保持连续。

## 为什么需要来源域单写者

原生并发基线不是安全的：三个进程在完全冷启动的同一共享根上同步升级，复现 marketplace 回滚时的 `Directory not empty`，以及安装过程中来源文件消失。因此必须协调整个原生升级和最终插件安装，不能只给 writer 创建加锁。

协调目录位于共享 `plugins` 的物理根：

```text
plugins/.kanban-source-installation-coordination/
  native-source-installation.lock
  source-installation-controller-owner.json
  source-controller-completion-<operation-id>.json
  source-installation-<complete-source-digest>.json
  source-installation-progress-events.jsonl
  native-launch-preparation-intents/<intent-id>.json
  native-attempt-<attempt-id>/
    native.stdout.json
    native.stderr.log
    native-completion.json
  native-installer-<id>/
```

所有主、侧及辅助入口按同一物理根协调，不按 profile 分锁。控制器记录进程代际与操作身份；即使外层租约过期，也不能越过仍执行的控制器。控制器完成或退出后，还须核验前一个完整来源状态中的原生子进程，避免另一个 profile 用自己的空记录绕过在途安装。原生进程的唯一 nonce 在 spawn 前持久化，并进入实际 `log_dir` 参数，PID 落盘前退出也能从命令行补证。

同名 marketplace 的 URL、ref、sparse paths 和实际 revision 都参与判断。不同物理来源隔离；相同名称或相同版本号不能证明同源。不同 profile 对同一物理安装位置选择相互冲突的来源时，按原生共享位置语义串行更新，不承诺同时固定两套版本。看板之外直接启动的旧进程或手工安装不受此协调器控制。

## 原生激活、安装与普通进程读取

协调器使用私有 installer 配置副本，认证仍桥接原来源，SQLite 不迁移。先执行同步的 `codex plugin marketplace upgrade <name> --json`，配置中的 `plugins` 在这个阶段为空，只激活 marketplace。随后通过原生 `codex plugin add <plugin@marketplace> --json` 逐项补全插件，每项完成即持久记录。安装 JSON 完全由原生生成。

普通原生进程通过 `-c marketplaces={...}` 读取同一安装树的本地 marketplace 视图，避免各 app-server 绕过协调器自行异步 Git 升级。原始磁盘 Git 来源配置保持原样，本地／curated 等其他条目保留。完整 table 覆盖还避免原生 dotted key 对带点名称的引号处理差异。

全新主、侧会话通过同步原生入口检查真实 revision。恢复既有对话时，已完成安装的 marketplace revision、完整来源、插件实际路径及持久目录身份均吻合，才允许直接复用本地插件；这一分支不执行原生升级或远端 revision 查询。缺少完成记录、来源变化或缓存不完整时继续同步补齐；接管旧安装树时，为同步核验后复用的插件补记实际路径与目录身份，供后续恢复使用。同源辅助进程遇到尚未完成的刷新请求且缓存完成事实仍匹配时，共用该请求并只核验本地缓存；无待刷新请求时沿用原有核验流程，正常 prompt 提交路径不加入同步升级。

快速恢复仍持有来源域锁，先核验 writer、实际 executable、目录归属和在途原生写入者，再复核缓存。复用不代表远端更新完成：安装状态保存单调递增的刷新请求序号与已完成序号，准备意图绑定对应请求；同一完整来源的并发恢复合并到尚未完成的一轮刷新。新增字段兼容旧记录，未提供的安装序号视为零。

首次登记刷新后至少等待 30 秒，由现有配置补扫器调用持久恢复入口接续，不新增调度器、不启动会话或投递 prompt。新刷新序号会清除旧轮次的 marketplace 已检查阶段，保留插件完成事实和失败重试预算；恢复会重核验意图与当前 writer 配置，只有覆盖本轮请求的原生更新、插件补全和可信远端核验实际完成，才推进已完成序号。另一进程重启后仍可接续，已被同一轮刷新覆盖的准备意图只复核本地完成事实，不重复联网或安装。失败继续使用既有三次尝试、证据变化重试和机器等待规则。

真实更新仍可替换最终目录；来源与 revision 未变化时不应发生无意义替换。用户修改脚本、原生定义／内容哈希、禁用、撤销及批准门禁保持原有语义，不因快速恢复自动恢复脚本或重新签名。原生流程可能产生临时 materialization／clone，不能把它们当作最终插件重装。

同一来源锁内，相同插件 URL/ref 的远端 revision 核验复用一次结果（含未知结果）；来源 URL/ref 改变或原生 marketplace／插件安装改变事实后重新核验。缓存不跨启动事务。未知 revision 只允许沿用完整缓存并保持待更新，不写成更新成功。启动诊断逐项记录来源锁等待、原生更新、插件安装和 revision 查询耗时。

`codex_verified_installed_plugins_reused_for_resume` 记录恢复时命中的本地完成证据；`codex_deferred_remote_plugin_update_already_completed` 记录后台合并后直接收口的准备意图。`codex_shared_plugin_launch_preparation` 仍记录整个插件准备耗时，配置副本准备和前端 1 秒停留防抖不属于本次提速范围。

同步 CLI 的 Git 操作保留原生 Automatic 环境隔离：去除仓库作用域 `GIT_*`，使用私有普通 cwd 与发现上界，禁止交互提示及可选写锁，保留认证和只读 Trace2。私有 cwd 出现 `.git` 发现标记时不执行命令，不能借此继承任务仓库的本地 Git 配置。

## 缺证、中断与自动恢复

优先复用来源匹配的真实完整安装树。来源缺少 marketplace 树时，可核验旧 writer 的原生记录、Git HEAD 和无修改事实后复制完整树；不能手造安装 JSON。marketplace 已激活不等于插件已安装，缺失插件只经原生安装入口补齐。

每次需要协调的启动先保存完整来源配置与 writer 归属的准备意图，之后才等待来源锁。运行时退出不会丢失等待中的 profile 选择。后台补扫只接续仍与当前来源配置匹配的意图，不启动会话、不重复投递 prompt；配置已变化的旧意图保留为待核验。

每轮最多三次原生尝试。耗尽后仅观察原生完成回执、进程、目录、binary、认证及网络／revision 事实；事实改变后恢复资格，观察周期至少 30 秒。已成功阶段继续复用；跨 profile 复用还须核验完整 marketplace 来源、实际 revision、最终目录身份与原生安装 stdout 回执。控制器退出、原生子进程仍存活和来源不可达分别保存真实事实，不伪造成功。

已有完整缓存且更新暂不可用时，普通进程可继续读取已核验缓存，同时保留待更新状态。缓存不完整时只暂停依赖它的启动，机器条件恢复后自动补全。所有尝试保留确切目标路径、原生 executable、发起 writer 和失败原因；缺少系统写入事件时，实际文件写入者始终标为 `unknown`。

## 自动化证据与真实实例边界

隔离原生测试同时隔离 `HOME`、`CODEX_HOME`、`CODEX_SQLITE_HOME`、Git 和所有桥接目标，使用本地 Git fixture 与合成模型响应，不访问真实 Google Drive 或外部模型。原生完成以同步 CLI 完成回执及目录事实核验；app-server 用例另行实际提交两次 prompt，中间经过生产辅助入口启动同源进程，验证 hook 两次落盘、原生完整指纹与目录身份稳定。

覆盖顺序、多进程冷启动、真实 revision 更新、跨 profile 崩溃恢复、三次重试与断网恢复、旧安装树复用、URL／ref／sparse paths 区分、脚本修改、禁用和撤销。fixture 同时包含 hook 插件、仅 skills 插件、同 marketplace 第二个插件、独立 skills 和无关本地插件。

```sh
KANBAN_CODEX_NATIVE_CONFIGURATION_SYNC_SMOKE_BINARY=/absolute/path/to/codex \
KANBAN_CODEX_SHARED_PLUGIN_INSTALLATION_EVIDENCE_DIRECTORY=/absolute/persistent/evidence \
npm run test:guarded -- --project precommit-safe --project runtime-integration \
  test/runtime/terminal/codex-source-shared-plugin-installation-directories.test.ts \
  test/integration/codex-shared-plugin-installation-directories.integration.test.ts
npm run typecheck
npm run web:typecheck
```

真实运行实例还需在部署后观察自然换代采用的新绑定与辅助进程；当前任务不部署、不替换旧活进程，不把隔离测试或 `hooks/list=trusted` 冒充真实实例的 hook 执行事实。

## 恢复提速的部署后验证

| 行为 | 部署前覆盖 | 部署后待验 |
| --- | --- | --- |
| 完整缓存恢复不阻塞于远端更新 | 真实 Codex、Git Trace2、目录身份与内容摘要对照；辅助启动不额外升级 | 已部署运行实例的自然恢复确实命中复用，整个插件准备区间没有同步联网或安装 |
| 并发、断网及跨进程接续 | 两份恢复意图共享一轮刷新；断网保留未完成序号，另一进程恢复后只更新一次 | 无需重复制造同类故障 |
| 身份、输入与 UI 等待状态 | 原生会话身份与不重发 prompt 回归；桌面和手机自动化浏览器检查 | 无新增独占部署断言 |

任务 `5917d` 注册自动脚本 `def36579-19b0-4b37-8439-32bfa9df1cfb`，定义在 `docs/verification-definitions/codex-conversation-resume-installed-plugin-reuse.json`。资产位于 `~/.cline/kanban/verifications/def36579-19b0-4b37-8439-32bfa9df1cfb/`，`cleanup.mode=automatic`；部署记录后挂载 1 项自动检查、0 项人工检查。

脚本读取指定运行实例的只读诊断与新鲜心跳，只接受当前实例拥有的会话代际；再按该代的完整插件准备区间核对日志。尚无自然恢复样本时明确非零退出，不启动或重启用户任务，不把后台稍后的合法更新误算成启动阻塞。旧实例 dry-run 按预期未通过，无崩溃、超时或残留；部署与生产耗时仍待验证。

兜底清理：`kanban verification cleanup --verification-id def36579-19b0-4b37-8439-32bfa9df1cfb`。本次使用持久业务诊断，无需删除临时源码插桩。

原生依据：[同步升级 CLI](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/cli/src/marketplace_cmd.rs)、[marketplace 更新](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core-plugins/src/marketplace_upgrade.rs)、[Git 隔离策略](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core-plugins/src/git_policy.rs)。
