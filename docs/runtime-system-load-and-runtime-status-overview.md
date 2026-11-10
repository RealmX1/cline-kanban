# 系统负载与运行状态概览

全局顶栏的「系统」入口在看板、任务详情、跨项目视图及无项目时都可用。桌面按宽度逐步显示 CPU、内存摘要，窄屏压缩为「系统」，手机保留 44×44 图标入口。弹层始终展示整机 CPU、内存、数据目录所在卷的可用空间、Kanban 状态流连接、进程运行时长与跨项目活跃 Agent 会话数。

## 实现边界

- 一个运行时只启动一个 `startRuntimeSystemLoadAndRuntimeStatusSampler`，启动即采样，此后每 5 秒采样；采样不重叠，关闭运行时后不再发布。
- CPU 使用 `os.cpus()` 累计计时之差，除以全部逻辑 CPU 的时间容量，范围为 0–100%。首次、计数回退、CPU 数量改变及零间隔均返回未知。
- 内存为 `os.totalmem() - os.freemem()`，含缓存，不代表内存压力；显示单位沿用二进制 GB。磁盘读取 `getRuntimeHomePath()` 的 `statfs.bavail`，表示当前用户可分配空间。
- 会话由运行时合并各项目的 PTY 与 ACP 摘要，再通过 `resolveSessionFacets` 统计 `liveness=live` 且 `agentId` 非空的会话，包含主、侧及首页 Agent，排除普通 shell。
- 各项异常独立返回 `null`，界面显示「暂不可用」，下一轮重试。样本超过 15 秒显示「数据已过期」，新样本到达后恢复。
- `RuntimeSystemLoadAndRuntimeStatusSnapshot` 通过现有 WebSocket 的 `system_load_and_runtime_status_updated` 全局广播；hub 缓存序列化消息，在初次握手及重连后补发，覆盖握手期间的变化。没有新增 tRPC procedure。
- 浏览器将样本与连接事件写入独立 `useSyncExternalStore` 存储，采样不进入工作台 reducer。状态控件自己维护过期计时。
- 断连替代页也复用同一入口，可继续查看最后样本、重连状态和过期提示；恢复后返回工作区。

本版不保存历史，不增加图表、告警、进程排行或调度能力。

## 顶栏精简

目录面包屑已移除，项目归属仍由项目切换器表达，打开工作区入口保留。桌面左右侧栏开关移到内容区两侧的折叠把手，隐藏后仍可点击恢复；原快捷键及持久布局偏好继续使用。手机导航与侧栏控制继续沿用既有交互。

## 验证

采样测试覆盖 CPU 差值与异常恢复、内存和磁盘、会话 facet 统计、采样互斥与停止；状态流测试覆盖无项目广播、握手期间更新及缓存重放；前端测试覆盖独立订阅、过期及恢复、手机入口与目录移除。

```bash
npm run test:guarded -- --project precommit-safe test/runtime/server/runtime-system-load-and-runtime-status-sampler.test.ts test/runtime/server/runtime-state-hub-projects-broadcast.test.ts
npm run web:test -- src/components/runtime-system-load-and-runtime-status.test.tsx src/components/top-bar.test.tsx src/runtime/use-runtime-state-stream.test.tsx
npm run typecheck
npm run web:typecheck
```

浏览器验收为显式启用的集成用例，需要先隔离 `dist`、`web-ui/dist` 并构建。若测试保护层隔离 HOME，须用 `PLAYWRIGHT_BROWSERS_PATH` 指向已经安装的浏览器目录。截图可通过 `KANBAN_SYSTEM_STATUS_BROWSER_EVIDENCE_DIRECTORY` 写入持久路径。

```bash
KANBAN_SYSTEM_STATUS_BROWSER_VERIFICATION=1 npm run test:guarded -- --project runtime-integration test/integration/runtime-state-stream.integration.test.ts -t '系统概况在真实'
```

用例通过隔离 HOME、Codex 存储及 Git fixture 启动独立运行时，自动检查桌面、手机、项目切换、任务详情侧栏把手和断连恢复，不启动 Agent。
