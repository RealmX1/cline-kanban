# Prompt 和 Command 填入后的焦点交接

Prompts 和 Commands 的“填入输入框”共用详情视图的填入回调。它只追加内容，保留已有草稿及首尾换行，不提交消息；目标是当前选中的会话，包括侧会话。

显式填入经 `AgentInputShortcutInsertionFocusHandle` 立即交接焦点。详情视图先用 `flushSync` 显示输入界面并提交草稿，再在同一次用户点击调用栈内聚焦。手机切回 Chat；PTY 阅读覆盖层先关闭；共享 conversation composer 将光标移到草稿末尾。入口未挂载或禁用时返回 `false`，不保留延迟聚焦请求。

切卡或挂载时的自动聚焦仍由 `shouldHandOffKeyboardFocusToAgentEntryNow` 管理。显式填入允许在手机端聚焦，不应为此放宽自动聚焦对手机、文本选区、其他编辑入口与对话框的保护。

填入按钮的 `mousedown` 阻止默认焦点转移。手机上的 Prompt 面板常在隐藏时挂载，来源条目在获得焦点后可能重新计算高度；若先让工具按钮获得焦点，按钮会在按下和抬起之间移动，点击最终落到来源条目而丢失。填入按钮直接把最终焦点交给 agent，键盘启用仍走原生按钮的点击处理。

不要改成阻止 `pointerdown` 默认行为：WebKit 的真实触摸序列会因此丢掉填入点击。工具栏由条目的 pointer enter/leave 与 focus/blur 局部状态共同控制可见性和点击命中，避免 WebKit 在条目已 hover 时仍将 CSS `group-hover` 工具栏保留在 `pointer-events: none` 状态；工具栏仍按既有的悬停或焦点规则显示。

自动化覆盖组件、真实 xterm、ACP composer、桌面和手机视口、触摸、键盘启用、阅读模式及粘贴帧无额外提交键。浏览器验证入口是 `web-ui/tests/prompt-library-agent-input-focus.spec.ts`，所有 API 和 WebSocket 均被隔离替身截获。快速切卡回归使用配置的 `baseURL`，可在独立端口运行。

Headless 浏览器可确认 DOM 焦点与后续键入归属，不能证明真实手机的系统软键盘已弹出；部署后的真实设备与原生 agent 集成证据单独记录在 PDV。
