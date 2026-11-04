# 独立 PTY host 的持久偏好与部署连续性

全局 `config.json` 的 `agentSessionPtyHostEnablementPreference` 保存 `enabled` 或 `disabled`。字段缺失代表产品默认启用，不写回一份伪造的用户选择。设置页“终端 agent 可靠性”开关复用 `runtime.getConfig/saveConfig`；保存后下次 runtime 启动生效，不自动重启。保存其他设置以及 project 配置的读取/转换不能丢失此字段。配置解析错误保留原文件并报告错误，不能当作首次使用覆盖它。

启动时先判断自动端口、remote-host、Windows 与 Electron 限制，再采用临时环境覆盖 > 用户持久选择 > 缺省启用。`KANBAN_AGENT_SESSION_PTY_HOST_MODE` 保持旧的 trim/大小写兼容；已设置但无法识别的值仍关闭并明确报告无效覆盖，变量缺失不表示关闭。机器重启后重新读取偏好，不承诺保留断电前的活进程。

## 实际宿主与恢复

在 workspace registry 和任何 PTY 创建前加载偏好。受支持实例关闭新托管时仍发现并接回存量 host；不把存量进程迁移为进程内 PTY。不支持的启动方式若发现活 hosted 会话或归属未知会拒绝启动，等待原会话自然结束或恢复受支持方式。

同一 runtime home + 固定端口先持久认领 controller 所有权，核验 PID 与 OS 启动身份，再进行握手。只读诊断使用非 controller 的一问一答通道，冻结的 controller hello 不变。旧 host 不懂新消息时，只能从所属 runtime 已拥有的 controller 连接获取当前列表；无法补证则保持 `unknown`，不能为了诊断顶掉 controller。

host 就绪最多 3 次、总预算 30 秒，重试间隔 1 秒/3 秒，单次最多 8 秒。阈值用 `EXPERIMENT_NODE` 标注。按 runtime 身份持久保存证据指纹、已消费次数、下次检查时间与恢复条件；崩溃重启不重置同一失败预算。预算耗尽后每 30 秒只读探测；host 恢复响应或 build/config/依赖证据变化后自动接续。当前快照与追加的 `*-progress-history.jsonl` 分别保存当前状态和历史尝试。

显式重开已有托管会话时，先等待原 hosted 进程确证退出，再创建新会话；三十秒内无法确证就拒绝新建，不强杀、不放松去重门禁。

controller 请求和恢复用的只读查询到期后，先让已就绪的 socket I/O 处理一次，再判定是否仍未收到回应。这样 runtime 事件循环长阻塞后，不会抢在已到达的回应前报超时；原请求期限不重置、不重发请求。真正超时的错误包含请求类型、期限、实际耗时和超时回调延迟；宿主通信失败与 agent 二进制启动失败分别呈现。显式重启期间，终端面板立即显示等待提示，超过十五秒显示等待时长；只有本次新一代进程实际启动后才写入完成提示。

只有确认对应 hosted 会话尚未创建才允许进程内降级。spawn 前先保存唯一 session key；回执丢失后查询同一个 key，归属未定时保留持久记录并等待，不重发 spawn、不降级创建另一份。runtime 与 host 两层都检查 workspace + conversation 唯一性。host 恢复后只有后续新会话进入独立 host，已降级会话维持原归属。

待核对记录串行原子写入，并保存原 host PID 与 OS 启动身份。原 host 确证退出或 PID 已换代时，先追加持久解除证据，再清除当前阻塞；没有在途创建时，也可用同一原 host 的“原 key 不存在”响应补证。仍活着或身份不明的原进程不能据陈旧 socket 判作已退出。runtime 退出前等待在途创建与持久写入结束，再交还 controller 所有权。

## 接管时的终端模式检查点

host 的输出环形缓冲只有 2 MiB，长会话的全屏、鼠标、粘贴和焦点初始化序列可能已被覆盖。host 另外维护与保留起点对齐的模式状态：覆盖旧字节前先推进解析器；读取区间内的其他起点时，从该状态解析到请求位置。状态不会随输出淘汰，内存不随会话历史增长。

`attach_hosted_session_output_stream_response.outcome.terminalModeCheckpoint` 是可选字段，不改变握手或 protocolVersion。host 在同一个同步 attach 操作中绑定 `hostedSessionKey`、PID、创建时间和实际 `catchUpStartByteOffset`；runtime 必须全部匹配才使用。不能把 listing 时的模式用于后来已发生覆盖的追赶区间。检查点还保留未完成控制序列和 UTF-8 字符的解析前缀，避免从半截 CSI 开始打印协议正文。

恢复顺序是：可信完整屏幕检查点 → 实际重放起点的 host 模式检查点与原始输出 → 从偏移 0 开始的完整输出。完整屏幕没有覆盖缺口时继续优先保留屏幕与 scrollback；发生覆盖时先丢弃旧屏幕，再恢复实际起点的控制状态。历史终端查询始终不应答；尺寸调整仅触发重绘，不能证明模式已经恢复。普通 shell 不被强制切入全屏或鼠标跟踪。

解析器覆盖全屏别名 47/1047/1049、互斥鼠标跟踪 9/1000/1002/1003、xterm 支持的坐标编码 1006/1016、粘贴 2004、焦点 1004、RIS 和 DECSTR。按 xterm 的 32 个主参数处理子参数与超限参数。前缀最多保存 512 字符；超长 CSI 转为模式未知，字符串正文不进入模式解析，也不无限保存。

旧 host 不提供字段时，已有可信完整屏幕或完整输出仍可恢复；只有截断输出时，记录 `unknown_awaiting_native_initialization_or_checkpoint`。`terminalModesAreKnown: false` 随接管记录与屏幕检查点保留，后续 runtime 不能把这份屏幕升级为可信模式证据。原生 RIS 或五类模式的显式初始化补齐后自动重验，记录 `terminal-modes-recovered` 并发布更新；没有定时重放、重复输入或按 agent 名称猜测模式。重新接管取得有效 host 检查点也可恢复。

这一层解决 host 截断输出丢失控制状态；浏览器如何应用恢复快照及鼠标编码的快照往返仍须分别验证，不能以其中一层通过代替另一层。

## 诊断

`kanban diagnostics agent-session-pty-hosts --json` 和 `runtime.getAgentSessionPtyHostDiagnostics` 共享只读状态，包含配置来源、冻结的启动意图、当前实际模式、generation 就绪情况、runtime/host 启动身份、逐会话归属、pending spawn 与恢复进度。设置页通过现有 runtime state stream 接收失效通知，不承担后台编排。当前配置和启动快照分开显示，避免把“已保存、待重启”当作当前已切换。

CLI 无法取得所属 runtime 响应时只读历史快照与原生进程，明确标记 offline/unknown；历史日志和 socket 文件不能单独证明当前保活。原生输入接受只投影当前 native session + incarnation 下的确证，不把历史补证当作部署后的新输入。

## 持久启动链与首次部署

本机链路为 launchd 登录恢复 → tmux resurrect → `ensure-restored-kanban-services.sh` → `run-cline-kanban-3484-service.sh`。服务启动脚本不维护另一份启用变量，runtime 每次读取同一全局配置；HTTP 就绪后还核对实际托管状态。恢复 3484 使用新 tmux window 尝试服务内核锁，避免向现有 supervisor 发送 C-c。修改前后脚本副本、SHA-256 和补丁保存于本任务持久交接目录；本任务不替换运行中的 supervisor。

部署流程见 [local-deploy 检查清单](../.codex/skills/cline-kanban-local-deploy/references/kanban-runtime-upgrades.md)。`verify-agent-session-pty-host-runtime-readiness.mjs` 只做检查；`--before-runtime-restart` 要求所有活会话均可保留，`--wait-for-natural-session-exit` 有界等待并持久记录条件。原 runtime 保持运行，不自动 Stop/resume/强制迁移。旧 API 无新 procedure 时，自动交叉读取全项目会话 facet、原生进程树、监听身份及 generation；此替代路径只允许无活会话的首次切换，不声称已经验证热连续性。

交接、离线全停和回收由 dbfe4 在 local main 的实现负责，本任务不复制其控制流程，也不因读取其代码而自动同步 main。部署必须同时包含两侧兼容实现。停止前再次检查，并由 `runtime handover-restart` 在服务端核对资格；禁止中断非托管会话的 override 和部署时的全停命令。

`observe-agent-session-pty-host-runtime-restart-continuity.mjs` 读取本次部署明确指定的基线，只观察，不重启、不停止、不注入输入。它分别报告原进程/会话/host 身份连续、输出水位推进与自然新原生输入接受。输出必须在新 runtime 的观察起点之后产生，并由新 runtime 实际收到；部署前已推进的 host 水位或仅存在于 host 的字节均不算通过。观察起点保存于精确 runtime 记录，可在后续只读检查中复用；`--require-session-io-progress` 才要求后二者均获证。证据以新 runtime 的 PID、启动身份和候选源 commit 绑定，禁止靠 `latest` 选证据。首次切换没有 hosted 基线时，连续性保留待验，等待下一次已有活 hosted 会话的已授权 redeploy。

## 自动化验证范围

受保护测试覆盖偏好优先级、并发保存、坏配置保留、关闭时接管、只读诊断不抢占、持久恢复预算、并发 runtime、回执丢失和真实 PTY。打包测试隔离 HOME/CODEX_HOME/CODEX_SQLITE_HOME 与固定端口，使用两份不同 build，浏览器核验设置保存/重开/待重启提示。独立 tmux socket 验证全新 tmux server 清空临时开关后仍恢复持久选择。

真实 Codex CLI 使用隔离本地 Responses fixture，核对跨重启的原生身份、输入唯一性、输出和进程启动身份；该证据证明 CLI/PTY/协议集成，不等于外部模型服务的生产结果。生产安装、持久启动链实际激活和下一次授权 redeploy 的自然会话连续性另行注册部署后验证，不能由测试环境通过替代。

终端模式的打包回归使用隔离 HOME/CODEX_HOME/CODEX_SQLITE_HOME、固定端口、真实 PTY 与确定性 agent TUI fixture，不访问模型。它在输出超过 2 MiB 后 SIGKILL runtime，确认原 agent PID 保留，接管后将真实 WebSocket 恢复快照交给 Playwright 的 xterm，检查滚轮报告能改变会话画面、输入框未污染、没有外层页面滚动，并以普通 shell 的历史滚动作对照。先按 `AGENTS.md` 隔离两处构建输出，使用与原生依赖 ABI 一致的 Node 构建，再运行：

```sh
PLAYWRIGHT_BROWSERS_PATH=/absolute/path/to/playwright-browser-cache \
KANBAN_TERMINAL_MODE_CHECKPOINT_PACKAGED_RUNTIME_CLI_PATH=/absolute/isolated/dist/cli.js \
npm run test:guarded -- --project runtime-integration \
  test/integration/terminal-mode-checkpoint-packaged-runtime-restart-and-browser-wheel.integration.test.ts
```
