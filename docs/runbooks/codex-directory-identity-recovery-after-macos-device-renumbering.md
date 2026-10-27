# macOS 设备号变化后的 Codex 目录身份恢复

## 已证根因与现场边界

2026-10-27，现场 72 个 Codex writer 绑定中有 71 个保存的设备号为 `16777233`，当前设备号为 `16777229`。配置来源与专用历史目录的物理路径、inode 均未改变；把当前路径和 inode 与旧设备号组合，能够精确重现两个旧 SHA256 身份摘要。旧代码把 `st_dev` 当作跨重启不变的目录身份，因而同时拦截历史读取和旧进程恢复。

这证明本次门禁拒绝由目录设备号变化触发，不证明系统崩溃的原因。崩溃调查及 Task `922cc` 的配置审批、提示交互和发起者追踪属于各自任务。

## 持久身份与兼容恢复

原 writer 清单、summary 绑定、配置来源键、配置决定和历史转录保持原样。补证追加到运行时 HOME 下的 `codex-persistent-directory-identity-evidence/<物理路径摘要>/<原身份摘要>.json`，记录卷 UUID、物理路径、inode、目录创建时间、原身份摘要、原设备号、观测设备号和原绑定清单路径。完整证据文件原子出现，已有记录不可覆盖。

后续成功核验的挂载另行追加到同一路径下的 `verified-mount-observations/<原身份摘要>.<挂载资格摘要>.json`。每条观察保留卷与目录指纹，并记录当前 OS `kern.bootsessionuuid`、设备号及块设备节点路径、inode、ctime 和 rdev；原补证与已有观察均不覆盖。

已登记目录用卷 UUID、inode 和纳秒创建时间核验。目录真实替换、换卷、原绑定清单不一致、历史桥接被改指另一目录时继续拒绝。设备号变化本身不改变配置来源身份，也不制造新的共享设置命名空间。新进程继续继承同来源的既有配置决定。

旧格式没有卷快照时，首次补证还要求：

1. 原 writer 清单与绑定一致。来源观察和没有 `previousBinding` 的新 Task 都独立查找同来源的原清单，包含退休及辅助 writer；来源恢复只核验原清单与来源目录，不要求先恢复旧 Task，也不依赖旧历史桥接。旧会话恢复仍须另外通过配置文件与历史桥接门禁。
2. 当前目录与原清单位于同一设备，目录创建时间不晚于绑定。
3. 原物理路径和当前 inode 加上 Darwin 同 major 的一个旧 minor，精确重现旧身份摘要。枚举范围固定为 `0..4095`；匹配不到即保留未知状态。
4. 原生执行前异步取得当前卷 UUID，再持久登记补证。后续重启直接核验补证，不重新解释旧绑定。

旧格式无法证明其他卷的归属时继续保留原绑定；不删除目录、迁移历史或修改摘要来“修复”错误。

已登记来源的原清单缺失、不一致或目录指纹不符时，扫描保留该来源的未知状态，新 Task 不会按相同路径另建来源或静默丢弃共享决定。一份损坏的 writer 不否定其他可独立核验的同来源绑定；无关来源的故障也不拦截可靠来源。

同一物理来源若在旧部署中已经形成多份有效来源键，显式 previousBinding 或 writer-home 推定的 parent 续跑必须核验并保留 parent.sourceIdentity、共享决定和 targets 归属；不因另一来源更早而重新选归属。只有没有 parent 的全新 Task 才选择可独立核验的默认旧来源，不静默合并已有命名空间。

## 系统查询与恢复条件

配置 store 的全局写锁不能等待系统命令。来源观察、writer 准备与目标冲突处理先在锁外预取所需卷／启动会话观察；取得锁后重读当前 store，再完整核验原清单、parent 来源、历史桥接、目录指纹、设备节点、缓存或持久观察。锁外预取不是后续执行资格，等待锁期间目录或节点改变仍拒绝。writer 的原生 `--version` 探测也在锁外完成，参数、环境和 PATH 查找语义保持不变。

store 只在持锁操作回调及其全部异步续接中设置“禁止系统查询”作用域。该作用域内的所有目录身份入口只做同步重核验，不能因遗漏某条调用链而再次启动或等待系统查询；资格不足时保留未知，锁外入口后续重新预取。退出回调后不继承该限制，不增大全局锁重试预算，也不把另一可靠来源的启动失败当成慢卷的必要副作用。

卷查询经异步 `df` / `diskutil` 完成，每条系统命令有五秒超时，同设备查询单飞，成功缓存三十秒，失败冷却五秒。启动会话 UUID 另经异步 `sysctl` 单飞取得，成功后保留在该进程，失败冷却五秒；进程重建后重新取得。卷缓存同时绑定块设备节点指纹，查询前后必须一致且 rdev 匹配目录设备号；节点变化即使设备号没变也必须重查，不能用旧 UUID 为新节点登记成功观察。同步历史读取只检查原清单、目录指纹与桥接，不启动系统命令、不写补证；原生启动或写配置前由异步入口完成卷核验。

系统查询暂不可用时，原设备身份或已核验的同一挂载仍可沿用现有证据；跨挂载执行需要卷证据，暂时不足时保留原绑定。既有配置观察器后续扫描和启动入口会在冷却后重新核验。恢复条件是系统卷查询可用、原卷身份与目录指纹匹配，或被误替换的原目录及桥接恢复。

已有补证的查询失败回退必须匹配当前 OS 启动会话、设备号、仍存在的同一块设备节点及目录指纹。进程重建可以读取持久观察；系统重启、设备节点被替换、从未核验的新挂载或卷 UUID 不符都不能仅凭历史设备号放行。首次没有补证但当前设备摘要精确匹配的目录，继续沿用原设备身份判据，卷查询恢复后自动补证。

追加挂载观察前还须将本次签发所用的同一节点快照与 UUID 缓存的节点指纹比较；缓存检查后节点被替换时当前调用拒绝，不为新节点签发旧 UUID。后续入口按既有冷却重查，核验成功后才追加新节点观察，原记录保持原样。

其他平台保持原设备身份判据，不应用 Darwin 的旧设备号恢复规则。自然观察仍须分别证明“门禁通过”“原生进程启动”和“Agent 接受下一条输入”；目录核验成功不等于原任务已经继续执行。

## 验证入口

```sh
npm run test:guarded -- --project precommit-safe test/runtime/terminal/codex-directory-identity-across-device-remount.test.ts test/runtime/terminal/codex-recorded-conversation-home-writer-bridge-identity.test.ts test/runtime/terminal/codex-conversation-storage-home.test.ts test/runtime/terminal/codex-configuration-writer-binding-and-sync.test.ts test/runtime/terminal/session-manager-codex-conversation-storage.test.ts
```

真实 Codex 配置隔离与原生历史检查使用独立 HOME 和本地合成模型：

```sh
KANBAN_CODEX_NATIVE_CONFIGURATION_SYNC_SMOKE_BINARY=/absolute/path/to/codex \
KANBAN_CODEX_CONFIGURATION_SYNC_EVIDENCE_DIRECTORY=/absolute/persistent/evidence \
npm run test:guarded -- --project runtime-integration test/integration/codex-configuration-writer-sync-native.integration.test.ts
```

部署后只读核验自然使用产生的旧绑定：补证与原摘要一致、真实原生转录 ID 未变、恢复进程仍指向原历史目录。不得为验证批量重启任务或向现有 Agent 注入新工作。

首次现场证据保存在 `/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/codex-directory-identity-recovery-20261027/`。现场只读验证与隔离测试均不表示已部署；运行实例仍须通过正式部署流程切换。
