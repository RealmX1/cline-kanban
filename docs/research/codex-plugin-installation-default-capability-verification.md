# Codex 插件安装默认能力核验

## 实施合同

用户已批准本方案并要求实施：新 Codex 版本默认自动核验共享插件安装能力，只有实际不可行才回退。范围为插件安装、启动资格及信任连续性；原生 hook 热重载等其他能力保留各自核验。源码提交、base 同步和部署不在本次授权内。

验收：新建、恢复和辅助进程共享同源安装记录；同 revision 不重装，内容不变时信任保持；未来版本字面值不影响资格；真实不兼容使用完整独立目录；暂时缺证有界重试并持久恢复；目录归属、禁用和撤销不能被回退绕过。

## 已核对的时间线

- `5f2b3644a` 于 2026-11-03 修复只共享插件、未共享原生 marketplace 安装记录的问题，同时将资格限制为 `codex-cli 0.166.0`。
- 真实 writer 首次在 11 月 3 日 13:08（America/Los_Angeles）记录共享布局；148 个 `0.166.0` writer 均带该绑定。
- 11 月 7 日 00:46 起出现 `0.167.0` writer，旧门禁将其送回混合布局。用户确认过的 ponytail 双哈希已保存，但随后安装目录和内容指纹再次变化。
- 用真实 `0.167.0` 在隔离 HOME 下运行既有 guarded 集成用例：三个插件 payloadDigest 相同，inode 全部变化，稳定性断言失败。测试使用匹配原生依赖 ABI 的 Node 24，未重编共享 node_modules。

## 实施分片

1. 持久能力证据：按实际 executable 身份、平台、依赖和协议修订复用；隔离行为核验；区分支持、不兼容与待重试。
2. 启动接线：取消版本白名单，保留已有来源归属；确认不兼容时完整独立布局；普通新建、恢复及辅助入口一致。
3. 验证和收尾：能力缓存/恢复回归、真实原生安装与 hook 回归、类型与格式检查、隔离构建、自审和部署后自动观察注册。

验证入口使用 `npm run test:guarded`，不直调 Vitest。构建前隔离 `dist` 与 `web-ui/dist`，不覆盖真实实例产物。

## 实现与验证事实

能力证据目录为 runtime home 下的 `codex-native-plugin-installation-capability-evidence/`。成功、不兼容和待重试独立持久化；每窗口三次预算、窗口间 15 分钟冷却、原 PATH 与工作目录、原生进程标记和逐次原件保留；同一程序的临时故障恢复后可自动续验，累计次数不重置。版本查询失败不否定行为，实际程序或 Git 依赖变化使缓存失效。普通启动在暂时缺证后自动接续，同一控制器已退出但原生进程尚未退出时只等待。配置服务关闭须等待补证收口。

新 writer、恢复和辅助启动均使用同一资格；不兼容时复制到完整独立目录，原生写入不能触及来源缓存。来源身份或目录被替换继续拒绝，不通过回退绕过。旧共享绑定和旧未核验记录仍可读取。

真实 `0.167.0` 的安装与信任用例 21 项通过，包含 Kanban 注入 hooks 全部为 trusted、未来版本字面值、相同 revision 不重装、两个真实合成模型回合中间启动辅助进程、跨 profile 信任、脚本变化、禁用、撤销、故障与重启接续。配置与能力回归最终 132 项通过，共 153 项相关用例；双端类型检查、Biome 和独立构建通过。

完整原生回归曾暴露双哈希测试的扫描时序竞争：监听启动的旧扫描可能尚未完成，单次 `scan()` 返回不代表刚保存的决定已被观察。测试现在先等待原始 writer 的本次决定进入持久观察记录，再验证后续 writer 的信任与撤销；修订后真实原生用例连续两次通过。没有放宽 untrusted、modified、禁用或撤销的断言。

额外运行的旧 `codex-hook-trust-configuration-refresh-native-cli.integration.test.ts` 四种路径用例，在未修改的 `2f5475f3381e0a6ece69ad3f8ce107f3948714ce` 基线也全部失败于同一断言：期待旧共享配置继续刷新新 hook。现行 writer 隔离策略明确不再刷新该文件；本次未修改此历史用例或宣称它通过。精确对照日志保存在本任务持久证据目录。

验证依赖与在线实例隔离：原共享 node_modules 落后于 lockfile，Git 包安装入口另有获取失败；验证使用本机对象库中与 lockfile 完全相同的 `233d3e765405fd27df0499c6cb4916ee3566d86b` 构建私有副本，并安装锁定的 zstd-stream。没有改依赖仓库、共享依赖、package.json 或 lockfile。

持久证据：`~/.cline/kanban/task-cross-task-handoff-artifacts/76b89/default-plugin-capability-verification/`。其中包含可重跑依赖准备脚本、基线对照、guarded 原生与单元回归、类型检查和独立构建日志。

## 部署后观察

注册一项自动脚本，ID `87b1e9f5-4490-573e-92c4-e301c7467623`，零项人工验证。脚本仅读取目标实例、当前代心跳及其新 writer，核对成功能力证据、双目录归属、批准和完整插件文件快照；先建立持久基线，再等待之后的自然启动，旧基线和失败观察进入追加日志。

没有自然样本时非零退出，不启动、重启、修改用户任务或自动确认 hooks。资产独立于 worktree，`cleanup.mode=automatic`；定义在 `docs/verification-definitions/codex-default-plugin-installation-capability-and-trust.json`，作者脚本在 `scripts/verify-observed-native-codex-plugin-capability-and-trust-continuity.mjs`。真实运行实例的接受事实仍须部署后观察，隔离测试不替代它。

注册自查返回 `count=1`。旧实例 dry-run 退出 1，明确等待当前代新会话采用自动能力核验，无崩溃、超时或残留。另用完全隔离的 HTTP/runtime 文件 fixture 验证首样本待验、后续稳定 writer 通过、同批准下脚本变更拒绝、新确认只重建基线及历史保留，五种情形全部通过。部署记录后预计挂载 1 项自动、0 项人工验证；本次没有执行部署或勾选通过。

兜底清理：`kanban verification cleanup --verification-id 87b1e9f5-4490-573e-92c4-e301c7467623`。本次没有仓库临时插桩。
