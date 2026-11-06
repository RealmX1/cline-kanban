# 紧凑 Focus View 实施验收记录

本轮依据用户提供并明确要求实施的方案完成四项调整：统一分组标题、工作台单行导航、TUI 信息浮层和浮动任务菜单。没有提交、同步、推送或部署。

## 实现与连续性

- `FocusViewGroupHeader` 同时服务普通 Stage、sticky 孪生标题及跨项目分组；桌面标题 32px、分组间距 4px。箭头折叠与标题定位是独立按钮，无定位能力的标题保持文本。
- Recent 筛选进入锚定浮层并显示条件数量，Running 使用紧凑计数。首张卡的悬停操作组通过 12px 顶部留白避让标题；sticky 焦点卡的总上下留白 20px 同步计入共享几何。
- `TaskWorkbench` 通过渲染函数提供 `headerNavigationContent`，模块将其放入现有标题行。布局选择移入首格菜单；工具内部导航、队列筛选、关系及可视化操作保持可达。空模块仍有宿主导航。
- 问答、资源和任务信息采用 Radix Portal 浮层，内部滚动，不改变终端高度。问答保留惰性查询和迟到响应隔离；手机控件进入原任务导航行，未移动终端内容节点。
- 任务操作菜单沿用主会话、Stage、Shelved、Done 与既有回调资格；Commit/PR 继续要求 Review 及工作树改动。失去资格关闭菜单，恢复资格不会重开旧菜单。服务端结案门禁未变。
- 按键栏收起按钮进入方向控制区，浮动滚轮与栏内滚轮互斥；信息、全局导航、按键栏及任务菜单各自持有展开状态。

## 自动化验证

| 验证面 | 结果与范围 |
| --- | --- |
| Web 组件测试 | 20 个文件、355 个测试通过；包括标题与滚动几何、模块输入和 iframe 身份、会话历史隔离、菜单资格、资源、评论及手机闲置机制 |
| 根 TypeScript | `npm run typecheck` 通过 |
| Web TypeScript | 构建中的 `tsc --noEmit` 通过，独立 `npm run web:typecheck` 亦通过 |
| Biome | 全部变更的 TypeScript/TSX/CSS 通过；`git diff --check` 通过 |
| 隔离 Playwright | 两个 spec 的 37 个唯一用例最终通过；覆盖 320/360/375/390/768px、769px 窄桌面和四种横竖桌面尺寸，菜单、浮层、实际 xterm、滚轮及软键盘可视高度变化 |
| 构建 | 隔离 `dist` 与 `web-ui/dist`，显式指定 `KANBAN_BUILD_DISTRIBUTION_OUTPUT_DIRECTORY`，以 Node 24.12.0 完成 `npm run build` |

浏览器完整回归先通过 28/37 个用例，修正问题后对剩余 9 个用例定向复测通过。修正包含菜单自身的 Escape 处理、桌面 DOM 不冒充手机滚轮区，以及两处过时测试夹具：评论快照补齐真实任务 incarnation，浮窗关闭与原生转录阅读按当前接口验证。另对 1080×1920 用例增加桌面往返手机断点的实际终端节点与连接连续性检查并通过。

测试全部拦截 HTTP 与 WebSocket，不启动真实 agent，不写真实关系账本。完整与定向运行日志在本工作树 `.cache/focus-view-*.log`，相关截图随 Playwright 输出保存。

验证环境中共享依赖与 lockfile 不匹配，使用本任务目录内的依赖覆盖层修复：探索图依赖从本机只读 Git 对象导出精确 commit `233d3e765405fd27df0499c6cb4916ee3566d86b` 并构建，`zstd-stream@1.2.0` 安装到私有目录。未修改共享依赖、package.json 或 lockfile。构建使用与原生 SQLite 模块 ABI 一致的 Node 24，未在共享依赖中重编。

## 部署后验证 authoring

本轮使用 `cline-kanban-post-deploy-verification-authoring`，仅注册定义，未执行或勾选真实实例验证。

| 行为 | 部署前已证 | 部署后待验 | 类型 |
| --- | --- | --- | --- |
| 终端、草稿与 iframe 连续性 | 组件节点身份、模拟 WebSocket、实际 xterm 跨布局及断点连续性 | 真实 agent/PTY、正在使用的可视化与新 dist 的组合 | `guided_manual` |
| 手机工具与浮层 | 各宽度触控尺寸、浮层边界、内部滚动、焦点返回和可视高度模拟 | 真实手机系统软键盘、安全区与生产实例全局浮层组合 | `guided_manual` |

`verification list --task-id 91ade` 已确认 `count=2`：

| verificationId | 待验断言 | assetsDir | cleanup |
| --- | --- | --- | --- |
| `f08a51af-8300-4ab0-a4b7-aec6d79c2e11` | 真实会话换格、改变布局与断点后，终端输出、输入草稿和可视化继续保留 | `~/.cline/kanban/verifications/f08a51af-8300-4ab0-a4b7-aec6d79c2e11` | `automatic` |
| `a3acf278-cb7a-4446-a245-53536e45cbd1` | 真实手机软键盘弹出时，信息浮层和右下控制保持可达且不遮挡最新输出入口 | `~/.cline/kanban/verifications/a3acf278-cb7a-4446-a245-53536e45cbd1` | `automatic` |

定义均绑定 `workspaceId=cline-kanban`、`taskId=91ade` 与 `task-detail:91ade` 稳定锚点。以后部署登记后预计挂载自动脚本 0 项、引导观察 2 项；本轮不含自动脚本，无脚本 dry-run，也没有临时 repo 插桩。

兜底清理命令，仅在决定撤销对应观察项时执行：

```bash
kanban verification cleanup --verification-id f08a51af-8300-4ab0-a4b7-aec6d79c2e11
kanban verification cleanup --verification-id a3acf278-cb7a-4446-a245-53536e45cbd1
```

额外方向及验收方向见 [实施合同](./focus-view-compact-workbench-implementation.md)。真实实例和物理手机结果仍为待验，部署前自动化结果不替代这两项。
