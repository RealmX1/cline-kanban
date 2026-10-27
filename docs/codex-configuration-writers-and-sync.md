# Codex 配置写入者与选择性会话同步

每代看板 Codex 原生进程持有独立、持久的 `codexConfigurationWriterBinding`。运行时重启接管同一绑定；原生进程替换时创建新的 writer，并保留旧副本与尚未合并的本地决定。旧共享目录只初始化一次，之后不再刷新其 `config.toml`，避免最终检查与原子替换之间覆盖原生 `/hooks` 保存结果。

配置目录在运行时 HOME 下的 `codex-configuration-writer-bindings-and-sync/writers/<writerId>/configuration-home`。绑定清单记录配置来源、历史和 SQLite 目录的物理身份、启动基线摘要与共享版本。`sessions`、`archived_sessions`、`thread-writer-locks` 使用核验归属的目录桥接；SQLite 继续使用原目录，认证仍引用原来源。配置文件本身必须是普通文件。历史查询、fork/resume、原生写锁与存储迁移继续依据历史归属，不从配置副本反推另一段对话。

历史转录中的 writer home 先按物理路径识别，再核验持久绑定清单、历史目录身份及历史与写锁桥接；HOME 的软链或等价路径不会改变历史归属。summary 缺少历史目录字段时可从已核验的清单恢复；普通旧 home 仍以原生转录归属为准。仅有目录形状、清单身份不符或桥接被替换都不能取得历史桥接资格。

共享默认保存于看板内部的 `configuration-sync-state.json`，权限为 `0600`。用户自己的全局 `config.toml` 始终作为来源，由其原所有者管理。独立历史 helper 与无状态 Codex 执行器也使用自己的配置副本，不能通过辅助进程刷新活会话。

## 增量与冲突

启动时的 `launchBaselineFields` 保持不可变，合并使用独立的 `mergeBaselineFields`，最近观测保存为 `lastObservedFields`。扫描只处理相对上次观测实际变化的字段。真实设置变化只登记待审批提案；扫描、会话启动与来源观测均不直接改写已有共享默认。通过后才更新未来看板会话默认，来源会话保留自己的本地改动。不同修改保存为冲突，处理冲突也必须核验提案版本、来源身份和当前定义。明确禁用、显式未信任、删除和重新启用都保存为有版本的决定，较新的重新启用不受永久的“禁用优先”规则阻挡。

hook 状态按规范化来源键保存，来源身份与定义摘要不同的目标不继承信任。向原所有者传播信任时，还核对原生 `hooks/list` 的 `currentHash`。主配置、外置 profile、旧内联 profile 的来源重定位采用同一规则；插件保持原插件来源身份。运行时注入的 `<session-flags>` 状态不进入共享默认。认证、环境变量、会话身份、SQLite 路径、项目路径和其他机器专属配置不进入同步状态，公开接口仅返回脱敏的值摘要。

配置来源、写入者文件和共享状态由目录监听发现变化；启动和五秒周期补扫提供替代路径。原目录身份或文件暂不可读时保留现场，公开 `observationProblem`，恢复后自动补扫。已经退休的 writer 保留历史，不再反复扫描。

## 用户操作与真实生效

原生界面的决定首先只影响来源会话。非模态通知支持持久收起；刷新、切换项目与新条目均不强制展开，收起不执行审批或稍后，展开保留选择与阅读位置。管理页分别展示设置待审批、来源更新与历史记录，提供筛选、单选、多选、全选当前筛选结果，以及批量通过、拒绝、稍后。稍后只撤下提醒，待审批状态保留；拒绝不采纳到默认；通过只更新未来看板会话默认。只有已通过或升级前已采用的设置决定才能显示单独的会话同步选项，且每条默认关闭。新变更使用新身份，浏览器重连、重复扫描与协调器自己的写入不会再次提醒同一条目。

同步目标包含同来源绑定的主、侧会话。写请求携带变更身份、预期版本和幂等键。目标保留自己的本地修改，发生冲突时须明确选择来源决定或保留目标决定；处理请求额外核验目标值的最新摘要。原冲突值和处理选择保留在持久历史中。

活副本的写入只通过原 app-server 的 `config/batchWrite`，带目标配置层的 `expectedVersion`。调用前核验端点代际、原生线程与配置文件归属；操作身份和“提交可能开始”事实先持久保存，再提交。受理、磁盘保存、原所有者重载和后续启动采用分别记录，不能从磁盘内容或 `hooks/list` 推断既有线程已经加载。

即时重载的已验证范围是 Codex CLI `0.164.0` 的普通 `hooks.json` 和主配置 hook 状态。未知版本、插件或 profile 生命周期、静态模型设置、启动参数覆盖及没有原所有者端点的会话会显示待重载或待下次启动，不冒报即时生效。明确禁用和撤销保留原决定，不表示已经开始执行的 hook 被取消。尚未隔离的旧共享会话保留现场，在自然重启时迁入。

相同证据最多尝试三次，次数跨运行时重启保存。端点、进程或配置证据改变后重新获得恢复资格。回执丢失先核验实际文件：值已经保存时只补幂等重载，不重写同一字段。后来出现的共享决定停止旧操作传播。后续原生启动采用选定变更时，记录独立的启动采用事实。

## 来源观测、迁移与批量审批

设置值与 hook 定义摘要分别比较。同一来源的定义切换即使被多个 writer、多个 hook、多个扫描轮次观测到，也归并为一条来源提示。原始记录继续保留；定义变化不授予信任、不更新共享默认，也不显示无效的审批按钮。提示只提供确认和稍后。

schemaVersion 2 将设置提案的审批、来源观测的确认和会话同步进度分开保存。旧版已经采用的默认值不回滚；旧设置记录标为历史事实，定义摘要变化归并为来源观测，均不伪造新的设置审批。公开文案分别说明变化、检测位置与影响范围，只有实际变化的值显示箭头；检测会话不代表修改者。

`runtime.batchCodexConfigurationAction` 为每项绑定条目类型、变更 ID、预期版本和幂等身份，返回逐项结果。过期、冲突、来源或定义暂不可核验的项保留待处理，其余项继续。重复身份只重放完成事实，不重复修改默认；回执持久保存。来源出现新的未审批设置时，旧同步会停止，已经发生的保存事实保留，新提案不会因此自动采用。

审批沿用目录恢复后已核验的历史来源键，不以当前裸设备号重新比较或重写旧 manifest。所选提案可以来自退休 writer；审批单独在 store 锁外预取其 source、history 与 SQLite 卷证据，锁内重读并核验绑定。source-only 提案只核验自身来源资格，不依赖退休 writer 的桥接。批量逐项持久化并释放锁，慢卷系统查询不占着全局锁阻塞其他来源启动。

## 新原生会话的权限继承

本任务实施期间，用户报告多个会话从 Full Access 变为 Ask for Approval，以及看板仍显示 Full Access、原生操作却需要审批。现场账本没有权限字段被传播的记录；当前实施会话的原生 ID 与启动核验的 ID 不同，新会话首个回合是 `on-request + workspace-write`。

隔离的 Codex CLI 0.164.0 实验确认：仅通过 thread RPC 恢复旧会话为 `never + dangerFullAccess` 时，同一 app-server 再创建新 thread 仍使用 `on-request + workspaceWrite`。现在受管宿主同时获得已选择且原生配置支持的权限默认，原有逐会话核验继续保留，计划转实施创建的新 thread 能继承 Full Access。专用 CLI 旗标继续优先于配置覆盖。

权限配置的 `-c` 覆盖保持原始先后顺序，较晚的点路径限制不会被较早的整体表覆盖；专用 CLI 旗标最后生效，并支持 `-s=read-only`、`-a=never`、`-c=approval_policy="never"` 等短选项附加值。新建与恢复宿主使用同一份配置分流，权限配置不再重复透传。

0.164.0 配置加载器拒绝旧 `untrusted` 字面值，原生 TUI 也拒绝 `-a untrusted`。逐 thread RPC 仍能为单个 thread 设置该策略，不能据此证明宿主为未来新 thread 提供同样默认值的资格：当前有效选择为 `untrusted` 时，在能力探测和目录分配之前明确拒绝受管启动，避免过滤后静默继承更宽松的全局默认，也不伪造等价配置。后项明确选择受支持的审批策略，或专用旗标覆盖该旧配置时，仍可使用受管宿主。显式 `--remote`、`--no-daemon`、profile 等既有旁路继续保留原生 argv 与原生错误。

原有只读 fork 和显式宿主旁路保持原生门禁。此处实验覆盖新 thread 的继承和真实后续回合，不把启动回执单独当作所有未来回合的权限证明。

## 只读发起者追踪

运行时启动基础采集，复用轮转 JSONL 日志，记录已知原生请求的用途、请求 ID、进程身份与核验后的 writer / 任务归属，并观察配置文件、hook 定义和插件缓存目录的物理身份、目录版本与内容摘要。不会为诊断主动调用 `plugin/list`，不会保存配置原文、认证或命令参数正文。

writer 归属补证在独立异步上下文中执行，所需卷观察先在事务之外准备；业务请求和连接关闭不等待诊断的慢查询。文件快照中的 dev / ino 只描述观察事实，不能代替目录身份与执行资格。来源、manifest 或桥接无法核验时记录未知，后续请求按恢复后的证据重验。

独立脚本支持先监听、核验就绪、采集初始快照，再启动命令，也可不带命令附着已有环境：

```sh
node --import tsx scripts/trace-codex-configuration-and-plugin-cache-change-initiators.ts \
  --evidence-directory "$HOME/.cline/kanban/codex-configuration-initiator-evidence/example" \
  --target-home "$CODEX_HOME" --duration-ms 60000
```

追加 `-- <命令> <参数…>` 可在监听就绪后启动命令。相同证据目录持有独占锁，并在 spawn 前原子持久保存提交可能开始事实。再次运行接续日志和快照，不重复执行先前的命令，提交结果不明也不盲目重启。证据目录须在被观察目标之外，交接时使用持久目录。

`--macos-write-events` 是独立排障模式，通过独立进程组运行系统 eslogger，收集 write / create / rename / unlink / 已修改 close 事件。需要 root 和负责进程的 Full Disk Access；权限依据见 [Apple 官方说明](https://developer.apple.com/videos/play/wwdc2022/110345/)。脚本用证据目录中的就绪探针确认订阅实际可用，再开始初始快照；探针不写入目标配置或缓存。退出时只停止自己拥有的系统采集进程组。

报告严格分为已证实的文件写入进程、可能的发起请求与未知。系统事件的 audit token、PID 版本和启动代际区分短命进程与 PID 复用；时间相邻只产生候选关联。文件通知和摘要变化不能证明实际写入者。系统序列缺口、格式异常、权限不足、目录不可读及采集预算耗尽都会留下覆盖缺口；基础采集继续，同一权限证据最多三次，权限能力指纹变化后自动恢复资格。所有快照有读取预算，文件变化最多三次补扫。

系统级权限尚未具备的环境只能验证降级路径与事件归一化，不能宣称查明真实写入者。插件缓存物理隔离仍属后续设计，本轮保持现有插件安装生命周期。

## 工作流阶段接缝

既有 RVF 快照增加内容寻址的 Skill 执行闭包，保留正文、references 和 helpers。插件 Skill 以其安装包为边界，普通 Skill 以自身目录为边界；不复制 `.git`、`node_modules` 和解释器缓存，外部解释器及原生二进制继续遵循既有安装与版本核验。闭包采集有文件数和字节数上限，文件变化或循环软链不伪造成功。

land/base 的阶段认领记录实际配置摘要、writer、启动共享版本、既有 Skill 快照摘要和通过逐文件验证的闭包入口。自动收尾提示要求使用认领返回的持久入口与相对资源。已认领阶段复用原认领；新阶段重新核验。Stop 和明确撤销检查继续先于执行资格，不因固定版本而放宽。旧阶段缺少新增字段时保留兼容路径。

这是本任务实现的接缝，不替代 RVF 原 run 的历史账本，也不建立独立的跨仓发布平台。来源 Task `7494b` 的原 `RVF-002` 及失败记录保持原样；本任务的验证不能冒充原 run 已收尾。

## 可重放验证

普通单测和 UI 测试：

```sh
npm run test:guarded -- --project precommit-safe test/runtime/terminal/codex-configuration-writer-binding-and-sync.test.ts test/runtime/terminal/codex-conversation-storage-home.test.ts test/runtime/terminal/session-manager-codex-conversation-storage.test.ts
npm run web:test -- src/components/codex-configuration-sync.test.tsx
npm run typecheck
npm run web:typecheck
```

真实 Codex 使用隔离 HOME 和本地合成模型响应，不调用外部模型：

```sh
KANBAN_CODEX_NATIVE_CONFIGURATION_SYNC_SMOKE_BINARY=/absolute/path/to/codex \
KANBAN_CODEX_CONFIGURATION_SYNC_EVIDENCE_DIRECTORY=/absolute/persistent/evidence \
npm run test:guarded -- --project runtime-integration test/integration/codex-configuration-writer-sync-native.integration.test.ts
```

打包态浏览器检查使用隔离 Git fixture、HOME、运行时和 Chromium：

```sh
PLAYWRIGHT_BROWSERS_PATH=/absolute/path/to/playwright-cache \
KANBAN_CODEX_CONFIGURATION_SYNC_PACKAGED_CLI_PATH=/absolute/isolated-build/dist/cli.js \
KANBAN_CODEX_CONFIGURATION_SYNC_BROWSER_EVIDENCE_DIRECTORY=/absolute/persistent/browser-evidence \
npm run test:guarded -- --project runtime-integration test/integration/codex-configuration-sync-packaged-browser.integration.test.ts
```

构建前分别核验并隔离 `dist`、`web-ui/dist`，显式设置 `KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY`。构建 Node 必须与所用原生依赖的 ABI 相符，不重编共享依赖来修复单个任务的环境漂移。
