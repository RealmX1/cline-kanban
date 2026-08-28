# Post-mortem：事件循环停摆 × 文件锁放大 → 全服退出

**现象**：重负载下，整个多项目 Kanban 服务器进程退出——所有浏览器标签页齐刷刷显示「Waiting for reconnection」。

**定性**：这是一条**两段式因果链**。崩溃现场（文件锁报错）只是放大器，真正的触发器是 workspace diff 的无界 git 子进程 fan-out 把事件循环卡停了约一分钟。只盯崩溃现场那一层会修错地方。

## 放大器：proper-lockfile 的 compromise 处理（`src/fs/locked-file-system.ts`）

proper-lockfile 的 advisory 锁每 `stale/2` 刷新一次锁文件 mtime。事件循环一旦停摆，刷新定时器错过，锁即被判 stale 并 **compromise**。此时有两条通往进程退出的路径：

1. proper-lockfile 的**默认 `onCompromised` 直接 `throw`**——该回调跑在 mtime 刷新定时器里，抛出即 `uncaughtException`；
2. compromise 后锁已被标记释放、锁文件已删，`withLocks` 的 `finally` 里 `release()` 会以 `ERELEASED` 拒绝——第二条 `unhandledRejection`。

两条都命中 `src/core/cli-process-guards.ts` 的 `installCliFatalErrorHandlers`（:115-126）→ `process.exit(1)`。于是**一次本身可恢复的锁抖动杀掉了整个服务器**。

### 已落地的加固（崩溃路径全部拆除）

- 调用方未显式提供时，安装「记录且绝不抛」的默认 `onCompromised`（`locked-file-system.ts:78-88`）：记 `[fs-lock]` warn（`src/fs/lock-diagnostics-logger.ts`，直写 `process.stderr` 以绕过 no-console lint 并进入服务器日志），把 compromise 降级为可用性事件。
- `release()` 包 try/catch、失败**绝不重抛**（`locked-file-system.ts:142-160`），日志分两档：良性（`ERELEASED` / `ENOTACQUIRED` / `ENOENT`——compromise 后的预期善后，:61）记 warn；意外（`EACCES` / `EIO` / `EPERM`，锁文件真删不掉、遗留陈旧锁）记 error 让运维察觉——遗留锁可经 staleMs 自愈，仍无需抛出。
- `DEFAULT_LOCK_STALE_MS` 放宽到 30s（:11；刷新周期 15s），吸收重负载下的 GC/IO/停摆抖动。**注意代码注释自己的定位：这只是纵深防御的调参，真正的停摆根因在 workspace diff 的并发治理。**

## 触发器：workspace diff 的无界 git fan-out（`src/workspace/get-workspace-changes.ts`）

那约一分钟的卡顿来自计算 workspace diff 时的**无界 per-file git 子进程 fan-out**：每个变更文件要读 old/new 内容（`git show <ref>:path` 子进程 + `fs.readFile`），`Promise.all(files.map(...))` 意味着 N 个文件在事件循环线程上同时触发 N 个 `uv_spawn`（git 子进程的 spawn 发生在 loop 线程），成百上千个 spawn 直接把事件循环卡死数十秒；机器上同时跑着十几个数百 MB 的 agent 进程时尤甚。

### 已落地的治理（三件套）

1. **numstat 批量化**：`git diff --numstat -z <range>` 一次拿全量统计（解析器 :180-186、调用 :221-225），`Promise.all(files.map(...))` 里不再 per-file spawn——N 次 spawn 收敛为 1 次。numstat 的 refspec/renames 标志必须与对应 name-status 调用完全一致（rename 表示随 diff 类型而变，细节见 `get-workspace-changes.ts` 就近注释）。
2. **跨请求共享的并发上限**：模块级 `p-limit` 单例 `gitFileReadConcurrencyLimiter`（`src/workspace/git-concurrency.ts`，上限 12）。关键在「共享」：即便 N 个 tRPC 请求各自 fan-out，总并发 git/fs 读也被钳成常数而非每请求各自 N。被限流的任务内部只直接调 git-show/readFile、不经此 limiter 入队，故不会自我嵌套死锁。
3. **stateKey 缓存**：三种 diff 变体（`working_copy` / `from_ref` / `between_refs`）都走 stateKey 缓存（:48-53、:493-501、:545-558、:613-627）——ref 先解析为不可变 commit SHA 纳入 key（:313-315），工作树侧纳入文件 fingerprints + untracked；空闲工作树上的每秒轮询因此坍缩为一次 fingerprint 比对命中缓存。

## 教训

任何在事件循环线程上**无界 fan-out 子进程**（`uv_spawn`）或做**大块同步 CPU**（另一个实测案例：`SerializeAddon.serialize` 序列化 20k 行终端内容）的路径，都可能停摆事件循环，并经上面的锁放大器升级为全服退出。对应的三条防线：**上限化并发、批量化子进程、缓存空闲重算**。审查新增代码时，对「在循环里 spawn / 在大输入上同步序列化」的形状保持敏感——单看每处都无害，叠加在共享事件循环上就是可用性事故。

## 后续观测面加固（2026-08-16 起，main 吸收）

事发之后又落地了一组诊断加固，让「下一次同类事故」不再靠猜：

- **event-loop-delay 监控改边沿触发 + 周期摘要**（`src/diagnostics/event-loop-delay-monitor.ts`）——细粒度采样转入 JSONL，常态不再刷日志；
- **按大小轮转的 JSONL 诊断事件存储**（`src/diagnostics/rotating-jsonl-diagnostic-event-journal.ts`）——诊断事件有了持久、可回放的落点；
- **pty 创建归因探针**（`src/diagnostics/pty-session-spawn-attribution-probe.ts`）——每次 pty 创建带「谁发起、是否重叠」归因；配套发现：`refresh_task_terminal` 占 pty 创建量的 68%，故客户端须显式声明启动来源（`runtimeTaskSessionStartOriginDeclaredByClientSchema`）才能把「人点的刷新」与「前端自动续跑」分开记账；
- **fd 水位探针**（`src/diagnostics/process-file-descriptor-watermark-monitor.ts`）+ **git 子进程失败上报**（`src/diagnostics/git-command-failure-reporter.ts`）——进程层资源耗尽与静默 git 失败都进日志/JSONL；
- **node-pty 升级 1.2.0-beta.15**——修掉每个 pty 泄漏 1 个 kqueue fd 的根因（fd 缓慢耗尽也是事件循环/进程衰减的同类前兆）。
