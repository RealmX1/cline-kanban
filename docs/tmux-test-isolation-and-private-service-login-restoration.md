# tmux 测试隔离与私有服务登录恢复

## 事故依据与源码归属

2026-11-13 两次远程中断的持久证据高度支持同一机制：c79ca 的部署集成测试继承生产 `TMUX`，仅设置 `TMUX_TMPDIR`，在 `finally` 裸执行 `tmux kill-server`。tmux 3.8 的自有 server 复现确认，未传 `-S/-L` 时继承 socket 优先于另一个 `TMUX_TMPDIR`。这能同时关闭生产 tmux 中的 3484 runtime 与 3485 代理。

历史时间由测试日志、进程环境与 runtime 退出记录交叉支持；没有历史 kill-server 进程的逐指令审计，不把反推时间写成命令原生执行时间。原始证据位于：

```text
/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/remote-access-runtime-and-proxy-recovery-20261113/
```

重点文件为 `事故分析与恢复结果.json`、`isolated-tmux-inherited-socket-precedence-evidence.json`、`historical-test-execution-and-production-tmux-environment-evidence.json` 与 `second-recovery-private-socket-verification.json`。

本任务起点与当时 local main 均为 `ea592d5225bc48eb1e6a75e717b3ad1051ed76bc`，不包含 `standard-local-redeployment-packaged-flow.integration.test.ts`。该文件仍属 c79ca 的未提交实现及其独立 RVF 候选。本任务没有修改或合入 c79ca 工作树；关系已登记为 `fixes-defects-in-produced-outputs-of`。

## 永久测试边界

公共 fixture 与 guarded runner 清除继承的 `TMUX/TMUX_PANE`，钉住各自私有 `TMUX_TMPDIR`。tmux 集成测试使用 `test/utilities/isolated-test-owned-tmux-server.ts`，启动、查询及清理均绑定同一个私有 `-S` socket，不加载用户 tmux 配置。清理核对目录/socket 身份与 server PID，只关闭该 server 内的自有 session；归属不符则保留现场，不退回 default server。

静态策略禁止 fixture 之外的直接 tmux executable 调用与 literal `kill-server`；它覆盖常见 import、alias、局部或直接 `promisify` 调用，以及 shell 参数里的 literal tmux/`kill-server`，不能证明任意外部生成程序都安全。派生执行器须显式接收私有 socket，所有 tmux 操作都使用它。不要用修改 cwd 或只清理某一个 `finally` 代替环境和调用链隔离。

独立自动回归覆盖成功、业务失败、真实 watchdog SIGTERM、socket 替换拒绝清理、重复清理和孙进程环境；父 server 的 sentinel、会话及 server PID 必须保持一致。既有两代 supervisor 测试也改用该公共 fixture。使用共享打包产物复验时要匹配其原生模块 ABI，不能为此重装共享 `node_modules`。

## c79ca 候选适配交接

本任务的持久交付目录为：

```text
/Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/d2d55/tmux-isolation-repair-20261113/
```

`c79ca-owned-tmux-adaptation.patch` 和同名 manifest 绑定三份来源源码的 SHA-256，附有只读原件和建议结果。适配把测试改用公共 fixture，并让派生部署执行器的查询、启动均接受 `serviceLaunch.tmuxSocketPath`，实际服务子进程清除 `TMUX/TMUX_PANE`。未提供 socket 的既有生产调用仍保持其原契约；该补丁不代表已经完成生产启动入口迁移。

这份补丁尚未应用到 c79ca，也未对其完整候选执行验证。c79ca owner 采用前应核对 manifest，先具备本任务的公共 fixture，再在其当前候选上检查并应用；来源变化时重新生成，不能覆盖 WIP。采用后候选摘要会改变，必须更新其独立评审/验证绑定，旧 RVF 记录不自动覆盖新候选。

同仓还有 b2f2f 的 Git fixture 扩展、fbe9b 的 PTY 生命周期回收以及 458b1 的 CI 改动。已只读比较本次相关位置；后续集成需同时保留各方行为。sibling survey 的 CLI 采集失败，使用持久看板快照，不能把其会话状态当作当前实时事实。

## 当前临时恢复入口

真实服务临时放在显式私有 socket：

```text
/Users/bominzhang/.cline/kanban/service-tmux-sockets/isolated-production-services.sock
```

持久且幂等的恢复命令为：

```bash
bash /Users/bominzhang/.cline/kanban/cross-task-handoff-artifacts/cline-kanban/remote-access-runtime-and-proxy-recovery-20261113/start-kanban-runtime-and-tailnet-proxy-on-private-tmux-socket.sh
```

该脚本复用 canonical runner，显式绑定私有 `-S`，清除服务子进程 `TMUX/TMUX_PANE`，已有健康服务时不重复启动。入口仍为 `http://100.90.180.11:3485/cline-kanban`，runtime 为 `127.0.0.1:3484`。运行情况会变化，恢复前后应只读核对 HTTP、监听 PID、tmux socket/PID 与托管会话身份；不能向生产会话注入探针或终止 agent。本任务没有构建、切换版本或重启真实服务。

## 登录恢复衔接

已核对的入口链为：LaunchAgent → `~/.local/bin/run-tmux-restoration-and-chatgpt-desktop-login-startup` → `~/Documents/GitHub/tmux-plugins/restore-all-tmux-sessions.sh` → `ensure-restored-kanban-services.sh`。tmux-plugins 顶层是仓库外的未版本化本机配置，不属于本任务源码工作树。

仅把末尾健康检查改为私有 socket 不够。当前 `~/.tmux.conf` 启用 `@resurrect-processes ':all:'`，原 resurrect 快照仍保存 3484 supervisor 和 3485 原始代理命令；插件可能先在 default server 重放它们。

已准备 `login-restoration-private-socket-adaptation.patch`、原件摘要及建议文件，尚未安装。其衔接顺序为：

1. 服务 ensure 的全部 tmux 调用显式使用现有私有 socket；以新窗口启动 canonical runner，服务环境清除 tmux 身份，不使用 `send-keys C-c`。
2. 登录恢复先执行私有服务 ensure，失败则保留日志并退出，不退回 default 启动生产。
3. 保留原 resurrect 快照，生成本轮专用副本，排除三个 Kanban 服务 session；其他会话照常恢复。插件通过已有 `_RESURRECT_DIR` 环境入口读取副本。
4. 普通终端恢复显式使用 `-L default`，避免手动从私有服务 tmux 内启动恢复时选错 server。末尾再次只读检查服务。

建议补丁通过 Bash 语法检查，并有使用替身命令的隔离自检；这些不等于实际登录已经通过。安装须由本机配置 owner 在核对原件摘要后执行，不需要为了安装而重启当前服务。安装后应自动验证健康重入不会换 PID、受控隔离恢复只重放非服务条目；真实注销/重启仍须遵守存量会话连续性门禁，不能为验证强制中断。

临时恢复脚本可在机器重启后再次运行；**在登录补丁正式安装前，原登录入口仍有回到 default server 的风险**。人工登录前先运行上述私有恢复命令能使已有健康服务免于 ensure 重启，但不能代替过滤旧快照的永久接线。

## PDV authoring 边界

| 行为 | 部署前覆盖 | 只有真实部署后才能证明 | 类型 |
| --- | --- | --- | --- |
| 测试和派生环境隔离、清理归属、父 server 保全 | guarded 自动回归 | 无；本次不改运行时行为 | 无需注册 |
| supervisor 两代独立 tmux 启停 | 隔离 HOME、端口及真实打包产物回归 | 本次未改变其生产实现 | 无需注册 |
| 真实登录恢复私有服务并保留存量会话 | 建议补丁的隔离自检 | 本机配置尚未安装，不能声称已实现 | 配置 owner 安装时再登记 |

本次不为测试改动创建假部署后验证，也不把建议补丁写成已上线行为。
