# Codex 配置写入者与选择性会话同步

每代看板 Codex 原生进程持有独立、持久的 `codexConfigurationWriterBinding`。运行时重启接管同一绑定；原生进程替换时创建新的 writer，并保留旧副本与尚未合并的本地决定。旧共享目录只初始化一次，之后不再刷新其 `config.toml`，避免最终检查与原子替换之间覆盖原生 `/hooks` 保存结果。

配置目录在运行时 HOME 下的 `codex-configuration-writer-bindings-and-sync/writers/<writerId>/configuration-home`。绑定清单记录配置来源、历史和 SQLite 目录的物理身份、启动基线摘要与共享版本。`sessions`、`archived_sessions`、`thread-writer-locks` 使用核验归属的目录桥接；SQLite 继续使用原目录，认证仍引用原来源。配置文件本身必须是普通文件。历史查询、fork/resume、原生写锁与存储迁移继续依据历史归属，不从配置副本反推另一段对话。

历史转录中的 writer home 先按物理路径识别，再核验持久绑定清单、历史目录身份及历史与写锁桥接；HOME 的软链或等价路径不会改变历史归属。summary 缺少历史目录字段时可从已核验的清单恢复；普通旧 home 仍以原生转录归属为准。仅有目录形状、清单身份不符或桥接被替换都不能取得历史桥接资格。

共享默认保存于看板内部的 `configuration-sync-state.json`，权限为 `0600`。用户自己的全局 `config.toml` 始终作为来源，由其原所有者管理。独立历史 helper 与无状态 Codex 执行器也使用自己的配置副本，不能通过辅助进程刷新活会话。

## 增量与冲突

启动时的 `launchBaselineFields` 保持不可变，合并使用独立的 `mergeBaselineFields`，最近观测保存为 `lastObservedFields`。扫描只处理相对上次观测实际变化的字段。共享值仍等于本地基线时接受新值；两边的值相同则合并；不同修改保存为冲突。明确禁用、显式未信任、删除和重新启用都保存为有版本的决定，较新的重新启用不受永久的“禁用优先”规则阻挡。

hook 状态按规范化来源键保存，来源身份与定义摘要不同的目标不继承信任。向原所有者传播信任时，还核对原生 `hooks/list` 的 `currentHash`。主配置、外置 profile、旧内联 profile 的来源重定位采用同一规则；插件保持原插件来源身份。运行时注入的 `<session-flags>` 状态不进入共享默认。认证、环境变量、会话身份、SQLite 路径、项目路径和其他机器专属配置不进入同步状态，公开接口仅返回脱敏的值摘要。

配置来源、写入者文件和共享状态由目录监听发现变化；启动和五秒周期补扫提供替代路径。原目录身份或文件暂不可读时保留现场，公开 `observationProblem`，恢复后自动补扫。已经退休的 writer 保留历史，不再反复扫描。

## 用户操作与真实生效

原生界面的决定默认影响本会话及未来看板会话。非模态提示显示来源、变更和范围，每条新变更的“同步到所有看板 Codex 会话”开关都默认关闭。点击“同步设置”只传播当前条目；“稍后处理”仅确认提醒，条目保留在设置页。新变更使用新身份，浏览器重连、重复扫描与协调器自己的写入不会再次提醒同一条目。

同步目标包含同来源绑定的主、侧会话。写请求携带变更身份、预期版本和幂等键。目标保留自己的本地修改，发生冲突时须明确选择来源决定或保留目标决定；处理请求额外核验目标值的最新摘要。原冲突值和处理选择保留在持久历史中。

活副本的写入只通过原 app-server 的 `config/batchWrite`，带目标配置层的 `expectedVersion`。调用前核验端点代际、原生线程与配置文件归属；操作身份和“提交可能开始”事实先持久保存，再提交。受理、磁盘保存、原所有者重载和后续启动采用分别记录，不能从磁盘内容或 `hooks/list` 推断既有线程已经加载。

即时重载的已验证范围是 Codex CLI `0.164.0` 的普通 `hooks.json` 和主配置 hook 状态。未知版本、插件或 profile 生命周期、静态模型设置、启动参数覆盖及没有原所有者端点的会话会显示待重载或待下次启动，不冒报即时生效。明确禁用和撤销保留原决定，不表示已经开始执行的 hook 被取消。尚未隔离的旧共享会话保留现场，在自然重启时迁入。

相同证据最多尝试三次，次数跨运行时重启保存。端点、进程或配置证据改变后重新获得恢复资格。回执丢失先核验实际文件：值已经保存时只补幂等重载，不重写同一字段。后来出现的共享决定停止旧操作传播。后续原生启动采用选定变更时，记录独立的启动采用事实。

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
