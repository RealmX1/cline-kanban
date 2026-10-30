# Codex 单次重启参数

Codex 终端的快捷重启保留原操作；悬停或键盘方向键会向下展开唯一的附加动作「带参数重启…」。触屏使用独立的展开按钮，主按钮仍直接执行。完整工具栏与紧凑头部共用实现。任务卡的 Prompt、Done 同样只在附加菜单中提供「复制原始 Prompt」「添加评论并结案…」。

参数弹窗允许空输入，活跃回合的终止提示直接显示在弹窗内。取消、引号未闭合或末尾孤立反斜杠不会发出重启请求；服务端也在停止旧进程前检查已知选项缺值与空字符。`--model --cd /path` 等输入不会把后一选项当成前一选项的值；字面值以连字符开头时使用等号或短选项紧连形式。提交期间禁止重复提交和关闭；请求错误保留输入供修正。

弹窗复用常规表单的 `Command/Ctrl+Enter` 主要操作快捷键，与按钮走同一解析、校验和异步提交入口；普通 Enter、组字及长按不触发重启。

## 传递与有效期

`runtime.refreshTaskTerminal.additionalAgentStartupArgumentsForThisRestart?: string[]` 沿现有重启链路到达 Codex adapter。前端与测试共用纯分词器：按空白、引号和反斜杠拆分，保留空参数，不进行变量、命令或通配符展开。双引号中的反斜杠仅转义引号、反斜杠、美元符号、反引号和换行，单引号中逐字保留。

参数仅在本次重启和现有的有界崩溃自动重试中使用。运行时深拷贝重试请求；下次手动重启重新构建请求，回收后为答题而恢复也清除本次补传。卡片与全局默认不保存这些 argv。原生 CLI 自身写入会话的模型或配置事实仍按既有恢复逻辑读取。

## 合并与原生语义

合并位置在 adapter 生成模型、权限、目录、会话选择与 hooks 默认参数之后，配置归一化及原生控制宿主转换之前。

绑定的 Codex profile 生成的模型、完整权限与推理配置也属于默认参数；本次补传仍最后覆盖，不修改持久 profile。

- 已知单值选项识别长短别名、等号与短选项紧连形式；补传覆盖默认，多次补传取最后一次。`--image`、`--enable`、`--disable`、`--add-dir` 等可重复选项保留顺序。分离形式的 `-i` / `--image` 可连续接多个图片路径；图片启动交给原生 CLI，不由受管恢复计划把后续路径解释成正文或会话 ID。
- `-c` 按配置键覆盖；`model`、`sandbox_mode`、`approval_policy` 等与专用旗标统一处理覆盖关系。`approval_policy.granular` 及其点路径配置也移除冲突的整体审批和自动权限旗标，不合并或丢弃不同 granular 子键。补传自动权限旗标也移除默认的单项权限。
- `--cd` 替换自动生成的 `-C`。Task 的工作树归属保持原来的任务目录，原生执行根目录以 CLI 实际恢复结果为准。
- 默认按已记录的原生 ID 恢复。显式 `resume`、`fork`、`--last` 交给原生选择，不用旧本地转录证明新目标；无 ID 且无 `--last` 的 `resume` / `fork` 直接打开原生选择器，不创建受管恢复计划。显式远程连接也不要求远端目标有本地转录。换目标或连接后，旧身份先清除，等待新的真实观测。
- 未识别的参数逐字保留，没有参数白名单。从第一个未知选项起，整个后缀均不再参与默认值覆盖、会话选择或连接判断；中间宿主把合并 argv 交给原生 CLI。需要宿主识别的已知覆盖项须放在未知选项之前，避免将未知选项的值误当成 `--last`、`--cd`、`--model` 或 `--remote`。显式连接与 profile 继续遵循原有的原生启动旁路。

合并后的参数进入现有配置 writer 启动记录。受管 remote 恢复的私有 `remote-conversation-bootstrap-receipt.json` 同时保存实际 TUI argv、原生会话 ID 与原生返回的执行目录；身份、目录及权限核对通过后才启动 TUI。

## 验证

真实 CLI 回归使用 `codex-cli 0.165.0`：隔离 `HOME`、`CODEX_HOME`、`CODEX_SQLITE_HOME` 和关系账本，仅连接回环模拟模型。测试先复现 `tui.resume_cwd="current"` 在 remote workspace 缺少显式 `--cd` 的警告，再补传含空格的不同工作目录，核对转换后的实际 TUI argv、原生 ID、执行目录、原生 turn context 与工具实际落盘位置。

```bash
KANBAN_CODEX_NATIVE_SESSION_TEST_BINARY=/path/to/codex npm run test:guarded -- --project runtime-integration test/integration/codex-remote-conversation-real-cli.integration.test.ts
npm --prefix web-ui run e2e -- tests/task-card-quick-actions.spec.ts tests/agent-session-restart-arguments.spec.ts
```

分词、覆盖、错误与取消、重试有效期、API 传递、会话预检、两种终端布局均有定向测试。真实部署实例的菜单层级和既有任务连接由本任务的部署后验证定义覆盖。

修复回归补充覆盖未知选项的不透明后缀、granular 审批冲突、多图片及缺值时旧 PTY 不被停止。隔离的 `codex-cli 0.166.0` 现场核验确认宿主生成配置经 `config/read` 和新 thread 读取后仍为 granular 审批；真实 PTY 分别显示 Resume / Fork 选择器；分离形式的三图片参数通过原生解析。
