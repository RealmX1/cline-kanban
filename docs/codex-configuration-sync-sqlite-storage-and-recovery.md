# 配置同步 SQLite 存储与恢复

> 历史实现记录。当前产品路径与旧数据的保全方式见 [Codex profiles 退役](codex-profile-retirement-and-storage-preservation.md)。


配置同步的权威状态位于 runtime HOME 下的 `codex-configuration-writer-bindings-and-sync/codex-configuration-sync.sqlite`。`better-sqlite3` 仅在专用 worker 内执行配置同步 SQL；数据库使用 WAL、`synchronous=FULL`、5 秒 SQLite 锁等待及独立只读连接。原有跨进程目录写锁仍保护锁外文件和原生协议取证，SQL 事务只覆盖持久提交。

## 读取边界

- 持续观测集合包含全部未退休原生 writer，包括没有待办的 writer。
- 执行集合包含待审批、冲突、当前配置仍适用的传播目标，以及待绑定和插件恢复工作。退休 writer 只有被明确引用或承担恢复工作时才进入快照。
- 历史展示独立分页，已批准但尚待采用的记录可以同时属于历史与执行集合。终态目标、完整冲突历史、全部来源关联及旧回执按 ID 读取。
- `getCodexConfigurationSyncOverview` 用于日常刷新、通知、配置选择与首屏；概览只读当前配置和反馈，不解码传播目标，采用计数直接在 SQLite 聚合。`getCodexConfigurationSyncActiveState` 保留旧活跃语义；`listCodexConfigurationSyncHistory` 默认 50 条、最多 100 条，搜索覆盖全部历史。
- `getCodexConfigurationSyncState` 保持完整语义。变更请求的 `stateResponseScope` 默认 `full`，新版 UI 显式选择 `overview`，`active` 保持兼容；该字段不进入原业务幂等摘要。

后台目标查询使用当前 profile 字段、版本与值摘要的索引。只有存在活跃目标的变更进入对应 partial index；旧格式兼容目标从目标状态索引读取，避免对每条终态变更探测一次。活跃来源提醒只携带每字段最新引用，服务端主动搜索通过关联索引覆盖全部原始引用。

`revision` 继续表示业务版本；任何实际存储变化另推进 `storageGeneration`，无变化扫描不提交。浏览器在同一存储内淘汰较旧代数；重连或发现不同存储身份时取消旧请求并重新绑定。分页游标固定首次序号上界，新增历史只提示刷新；已有记录修改或重新激活会使旧游标失效并自动重查。

## 首次切换

生产切换必须先按现有本地部署流程关闭旧写入启动入口，核验 runtime、CLI、helper 的实际退出与候选、HOME、Node ABI。早于现有内核写锁协议的进程另由部署协议切换 preflight 核验；目录锁本身不能证明这类更旧进程已退出。普通原生会话仅在实际拥有旧 JSON 写入路径时需要等待，不统一中断存活 PTY。

迁移取得同一目录锁后，依次持久保存精确原始字节、SHA-256、原权限与文件身份、迁移清单及规范化导入快照。备份位于 `configuration-sync-migration-backups/<migrationIdentity>/`。原 `configuration-sync-state.json` 被替换为旧 schema 无法解析的 SQLite 哨兵；旧版本再启动时明确失败。

导入数据、完整内容核验与迁移完成记录在同一 SQL 事务中提交。数据库外 `configuration-sync-storage-authority.json` 的阶段为：

`migration_prepared → sqlite_authoritative → legacy_rollback_prepared → legacy_restored`

提交前中断重试同一冻结快照；数据库已提交、外部清单未更新时按相同迁移身份补齐。存在哨兵或权威凭证后，数据库缺失、损坏或身份不符都进入恢复态，禁止读取旧 JSON 或初始化空状态。没有切换凭证但出现数据库文件时同样拒绝覆盖。

## 故障与未知结果

`configuration-sync-database-recovery-observation.json` 保存故障指纹、次数、下次健康探测时间与机器恢复条件。读故障、数据库写故障与跨进程取锁故障分别核验恢复资格；成功查询不清空写故障预算。同一条件连续失败三次后只进行间隔至少 30 秒的有界健康探测，领域动作先核验写资格；重启不清空预算。取锁故障由同一把锁重新取得补证，数据库写故障由无业务变更的短写事务补证，该事务推进 `storageGeneration`。已完成迁移的数据库重开不重复执行建表或写入 `user_version`。数据库物理替换会使旧 worker 失效，后续从权威凭证重新核验并打开。

原生提交可能开始阶段、操作身份和业务回执保持原有门禁。worker 退出或响应丢失不能证明业务失败：先查询原回执与原生结果，不换新操作身份盲目重发。历史来源提醒从活跃响应消失也不证明被替代；恢复先查回执，再按 ID 核验，未确认记录保留在浏览器持久存储。

## 回退到旧版本

先关闭所有 SQLite 写入启动资格，并核验 runtime、CLI、helper 已停止，保持普通原生会话的实际 PTY 连续性。复用部署流程的进程身份与候选核验，不通过“HTTP 健康”推断写入者已退出。

`restoreLatestCodexConfigurationSyncLegacyStorage` 是存储回退入口。它在目录锁内持久关闭 SQLite 写入门，从一致快照导出最新完整 JSON，核验代数和摘要，再恢复旧路径。只存于 SQLite 的插件准备意图先通过完整 schema、来源绑定、父目录物理身份核验并补回旧版能继续读取的文件。任何此类核验失败都保留写入屏障与原始记录。

导出位于同一持久迁移备份目录中的 `configuration-sync-latest-state-for-legacy-rollback.json`。中断后按权威阶段自动接续；已恢复的旧 JSON 可能已有新写入，恢复不能覆盖它。`legacy_restored` 会阻断新代码自动重迁。禁止直接复制迁移前备份回去；不要删除数据库或权威文件“重置”状态。

## 验证与交付边界

相关 guarded 测试覆盖精确备份、哨兵与权威文件替换前后中断、提交成功但 worker 回执丢失、跨重启故障预算、数据库物理替换、最新状态回退、插件父目录替换与冻结后直接回退恢复。规模测试分别扩大终态目标、冲突历史、退休 writer 和来源关联，比较解码行数与 V8 序列化载荷；SQL 查询计划另检查活跃索引。

打包验证须隔离 `dist`、`web-ui/dist`，并设置 `KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY`。Node 22/24 的原生依赖使用独立目录，不能重编共享安装。仅复制顶层原生包、其余依赖仍为符号链接时，仓库级 `npm rebuild` 仍可能遍历链接依赖；原生修复应在完整独立 prefix 内执行，或从匹配 ABI 的已核验缓存恢复具体文件。浏览器验证只使用隔离 HOME；不在真实关系账本或用户配置中制造测试数据。

这些测试不等于任意指令位置断电的证明，也不等于生产切换或整页性能验收。源码、部署、真实实例验收分别报告。原 SQLite 切换工作当时未绑定卡片，其注册豁免仅属于该历史交付；后续改动仍须按各自任务注册部署后验证。

## 本地状态投影与当前会话采用

`settingsIsolationProjectionVersion=2` 将 `tui.model_availability_nux.*`、`tui.screen_reader_detection_done` 和既有桌面字段排除在共享及默认编辑之外。旧 JSON 导入复用原迁移入口；已有 SQLite 在持有同一写锁时只执行一次完整归档事务，并在同次提交记录投影版本。事务中断后按版本重新核验；原生文件、初始化副本、原始历史和已应用事实保留，未完成目标记录取消前状态后停止传播。新观测也跳过这些字段，避免本地状态回流。

会话采用查询只接受当前 summary 给出的 workspace／会话／进程代际／writer 归属。writer 主键与持久绑定必须逐项一致；采用事实只读当前 writer 的对应目标及当前字段版本，不能把旧代目标合并到新代。`configuration_targets_by_writer` 支持按当前 writer 查证，计数不反序列化目标 JSON。会话列表返回轻量投影和稳定游标，不返回底层传播记录数。旧 `full`、`active` 读取、按需完整比较及原业务幂等回执保持兼容。
