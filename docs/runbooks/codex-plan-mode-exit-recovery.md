# Codex 恢复会话后的计划模式退出

当恢复后的 Codex 仍能聊天，但 Shift+Tab 无法退出 Plan mode 时，打开当前会话的「终端工具与更多信息」，点击「退出计划模式」。紧凑终端头部也提供同一操作。入口覆盖主会话与侧会话，作用于当前选择的会话。

此操作切至 Default，不提交输入框草稿、不批准计划、不启动模型回合，也不重启进程。用户仍需自行发送下一条指令。任务的 `startInPlanMode` 启动偏好不变。

## 原生协议与结果

服务端绑定 workspace、宿主任务、运行代次及原生会话 ID；拒绝已结案任务、过期身份和错误端点。确认目标 thread 已加载、执行目录一致后，通过 `thread/resume` 读取设置，再以 `thread/settings/update` 设置 Default，保留模型与推理档，并用 `developer_instructions: null` 交还原生默认指令。

操作不依赖 `collaborationMode/list` 或终端文字。运行中的回合与原生待答问题必须先结束或中断；接口不会替用户作答。

- `exited`：写入后已从原生设置确认 Default。
- `already_default`：原本已是 Default，未写入。
- `rejected`：本次未请求写入，原因显示在提示中。
- `unconfirmed`：写入可能已经发生，但结果未能确认；重试会先读取当前状态。

连接故障时最多重连一次。写入可能发生后只读补证，避免重复覆盖用户随后选择的模式。会话在请求中途停止、重启或 Rewind 时，旧请求不会更新新身份，也不会在新会话显示成功提示。

## 调查与验证边界

本机真实 Codex 0.168.0 的隔离验证通过代理返回空模式列表，重现了恢复后 Shift+Tab 无效，再使用新操作退出。验证确认 TUI 同步、含中文/英文/多行/连续空格的草稿逐字提交、下一回合使用 Default，以及退出后不再发送回合、重启原生宿主仍保持 Default。模型、推理档、审批与沙箱设置保持一致。

原生提交会裁去整段末尾空白，因此草稿样本以可见字符结尾，内部保留行尾空格；此规则独立于模式切换。用户现场「Shift+Tab 提示也消失」的原因尚未确证，不能仅据提示缺失判定模式列表状态。

原生验证使用隔离 HOME、CODEX_HOME、CODEX_SQLITE_HOME 与本地 Responses 模型服务，不调用外部模型：

```sh
KANBAN_CODEX_NATIVE_SESSION_TEST_BINARY=/absolute/path/to/codex \
KANBAN_CODEX_PLAN_MODE_EXIT_EVIDENCE_DIRECTORY=/absolute/persistent/evidence-directory \
npm run test:guarded -- --project runtime-integration \
  test/integration/codex-native-conversation-plan-mode-exit.integration.test.ts
```

Web 组件测试和 Playwright 分别覆盖重复点击、切换会话、只读/忙碌门禁，以及桌面/手机完整工具栏与 Focus View。真实部署后的菜单与原生控制宿主接线仍需由部署后验证核对。
