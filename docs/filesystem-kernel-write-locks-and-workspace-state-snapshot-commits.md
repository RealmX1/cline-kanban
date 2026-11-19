# 共享写锁、工作区快照与协议切换

共享文件写入使用执行该操作的同一 Node 进程持有的 SQLite `BEGIN IMMEDIATE` 事务。连接的 `timeout` 为零，争用经异步、有界退避处理；暂停进程、事件循环停顿和心跳过期都不释放锁，进程退出才由内核释放。多锁按规范路径排序并去重。

锁数据库位于 OS 账号持久 home 下的专用目录，不随 `HOME` 覆盖或 workspace 删除而改变。路径经过可解析父链的 `realpath`、NFD，并反复做大写展开和小写转换直到稳定，避免 `Σ/ς`、`ß/ss`、`ẞ/ss`、`ﬀ/ff` 等实际文件系统别名取得两把锁；大小写敏感卷上仅大小写不同的资源会保守串行。不能拿会随原子替换改变的目标文件 inode 作为锁身份，也不能在线删除或替换锁数据库。

锁专项测试用 `LockedFileSystem.forIsolatedTestDirectory` 显式绑定夹具根目录。父子进程共享该绑定，目标与显式锁路径须位于根目录内。锁数据库固定在根目录直属的 `filesystem-kernel-write-locks` 中，供工作目录删除重建后继续使用。夹具等所有自有进程退出和所有锁句柄关闭后清理。

`board.json`、`sessions.json`、`meta.json` 保留为兼容投影。完整快照日志持久提交后即为已提交状态，每次持久修改都有唯一 `workspaceStateSnapshotCommitId`，包括不增加业务 revision 的身份观察。投影暂时失败不撤销已提交日志；读取优先提供日志中的完整快照，后续写入先恢复投影，再检查 `expectedRevision`，不重做业务回调。

只修改 sessions 或原生身份时，在同一锁内保留权威 board 原始字节，完整日志及恢复投影均沿用它。不能把解析后的 board 重新序列化，因为旧字段、键序或空白变化会破坏关系账本核对悬挂批次的文件指纹。

公共读取不持写锁：用日志和提交身份核对读取窗口，只有完整快照或前后提交身份一致的投影才可返回。读取缓存必须同时纳入日志和 commitId；只看 `mtime`、size 或 inode 会漏掉同 revision 更新以及待投影日志。首次迁移保存旧文件的观测基线，只承认当时实际观察到的状态。

投影自动恢复使用三次有界重试。预算耗尽后每 15 秒只观察恢复条件；权限、文件身份、相关磁盘空间变化，或原有锁争用解除后，重新开始有界补投。锁的可获取性通过零等待取锁后立即释放确认，实际补投仍重新持锁，不要求持有者写入 JSON 才能接续。严格读取对日志与投影执行相同的正文有效性检查。

从旧 `proper-lockfile` 协议切换，或回退到旧协议，均须先核验旧写入者退出。执行入口是 `scripts/verify-filesystem-lock-protocol-transition-preflight.ts`；它不停止进程、不部署，只检查本次候选绑定的清单并持久保存恢复条件。

清单须来自部署过程已经核对的原生进程和会话归属，覆盖 runtime、CLI、hook、Codex 直接写入入口及仍可能启动这些入口的会话。关闭旧写入启动入口后生成清单，保留候选 commit、runtime home、真实 boot identity、PID 和启动身份以及旧命令路径。不能凭空将两个准入／完整性字段填成 `true`，也不能以一份过期进程表宣称完整。

专用只读检查器自身的命令路径引用不参与启发式扫描；显式清单中的同一 PID 仍须核对退出。其他进程的命令文本没有可靠 argv 边界，对退休路径及其 file URL 引用保持保守阻断，不把拆出的片段或部分重叠路径当作退出证明。机器清单应优先细化到不可变入口文件，必要时补取原生 argv 和物理归属后重验；在证据未补齐前仅延后协议切换。

```sh
node --import tsx scripts/verify-filesystem-lock-protocol-transition-preflight.ts \
  --retiring-writer-inventory /持久交接目录/retiring-writer-inventory.json \
  --evidence-file /持久交接目录/filesystem-lock-protocol-transition-evidence.json \
  --candidate-source-commit <本次候选的完整提交> \
  --runtime-home /本次实例的实际/runtime-home \
  --wait-deadline-ms 60000
```

只有 `ready_for_protocol_switch` 放行切换。存活旧进程返回 `waiting_for_retiring_writers`；证据不可读保留 `evidence_unavailable`。脚本有界等待，每 15 秒重验，退出码 2 表示尚未放行；同一候选和清单的恢复参数保存在证据文件中，可在条件变化后重新调用。继续其他独立实现和验证，不强杀现有会话。

回退加 `--rollback-to-legacy-locks`。存在待投影日志时返回 `waiting_for_snapshot_projection`，必须先在新协议锁内恢复日志，随后重验；不能将仍有日志的 JSON 投影交给旧版本写入。

部署授权、备份、PTY 会话连续性、运行 Node ABI 核验和重启流程继续遵循本地部署 skill。该检查本身不授予部署、重启或回退权限。
