# 已访问任务列表与前后导航

## 实现合同

按已批准方案，在桌面和手机顶栏提供后退、前进与最近访问列表。列表跨项目，记录实际显示的详情和 Backlog 编辑窗，排除悬停预览与新建表单。导航采用浏览器的分支与游标语义，历史跳转成功显示后才提交游标。

任务身份包含 workspace、task ID 与 incarnation；跨项目打开复用现有入口，迁移沿现有身份查询定位，删除重建不能冒充原任务。Backlog 窗口复用原实例；任务迁移后历史导航仍展开迁移前那扇窗，不按新项目另开。历史切换只收起其他任务编辑窗，保留草稿、字段和位置。

历史用版本化 localStorage 保存，最近列表与路径各限 200 条；每个标签页独立运行，新页面读最后保存的快照，不自动打开任务。明确 URL 优先，布局重置不清历史。临时断连保留记录，恢复连接后对仍有效的意图最多重试一次；若恢复发生在这次失败被观察到之前，发现失败时立即使用这一次重试。持久化失败保留页内能力并提示。

不新增后端 API、依赖或跨 origin 同步，不改变任务状态、提交代码或部署。

历史 controller 不监听其他标签页的 storage 更新；后台身份补证核对存储仍是本页最后保存的快照后才持久化，不覆盖另一个标签页最后操作保存的路径。普通访问与成功历史跳转提交新的浏览器恢复快照。原项目已注销时，复用其他已注册项目的全局身份查询定位迁移目标，仍核对原 workspace 别名与 incarnation。

非模态窗口宿主位于 `TaskCommentsDialogProvider` 内，以保留评论、项目标识和其他领域 context。App 通过 `BindTaskNavigationToFloatingFormWindowHost` 取得实际宿主；不能直接在 App 顶部调用 context hook 并假定能看到子树里的 provider。展开事件由实际窗口发出，创建表单和普通重渲染不产生任务访问。

## 实施切片与验证

1. 历史状态与持久化：先测分支截断、重复访问、跨项目身份、边界、200 条上限及无效存储，再实现状态变换。
2. 打开结果与常驻编辑窗：验证成功、取消、失败、迁移、重建、迟到结果和草稿保留，再接入 controller。
3. 顶栏与快捷键：复用现有按钮及 Radix 菜单，捕获终端和编辑窗内快捷键，模态与 IME 让行；用 Playwright 检查桌面和 320px 手机。

影响面为前端历史 controller、共享跨项目打开 hook、非模态窗口宿主、任务编辑窗、顶栏、App 接线及对应测试。主要风险是跨项目同号误开、异步导航旧结果覆盖新意图，以及把背景重绘当成访问；分别以 incarnation 核验、取消身份和实际显示事件约束。

验收运行针对性 Web UI 测试、根项目与 Web UI typecheck、Biome、隔离构建与 Playwright。真实运行实例的断言单独登记到部署后验证面板。

## 验证结果

2026-11-16 完成批准范围实现，未提交、同步或部署。

- 9 个针对性单元／集成测试文件共 162 项通过，包含历史状态、身份解析、controller、共享打开入口、已有任务编辑器、浮窗宿主、顶栏和详情 URL 导航回归。
- 7 个 Playwright 用例通过：桌面／320px 最近列表、macOS／Windows／Linux 键位、真实 xterm 输入事件拦截、长按／IME／模态边界，以及桌面／320px Backlog 草稿、选区、字段节点与拖动位置恢复。已检查两种尺寸的实际截图。
- `npm run typecheck`、`npm run web:typecheck` 和本次 TypeScript 改动的 Biome 检查通过。Node 22 运行 typecheck 和针对性测试。
- `npm run build` 完整通过。构建前已将本任务 `dist` 与 `web-ui/dist` 从主仓库共享软链隔离；原生依赖属于 ABI 137，因此使用本机 Node 24.22.0 构建，未重编或改动共享依赖。

浏览器复现入口：

```bash
npm --prefix web-ui run e2e -- --config playwright.visited-task-navigation-isolated.config.ts
```

截图保存在 `~/.cline/kanban/browser-test-artifacts/visited-task-navigation/d092ec15cba90ee2/`。完整构建及输出隔离记录保存在 `~/.cline/kanban/task-validation-artifacts/27ba5/visited-task-navigation/`。

## RVF 评审与前台收尾

首次 RVF 在固定起点 `da31446b04612544e34a7d7faf41656f33e331bd` 上完成双审，发现 7 项问题，独立 Validate-Fixer 在修复候选 `2d6b317e2ee93a9c786652b1217a9416d16df6ae` 中逐项修复并应用到当前任务未提交工作树：迁移后的编辑窗复用、AI 查卡关闭后再显示详情、手动重新展开撤销旧意图、先恢复连接再失败时补试、迁移别名合并相邻路径、打开阶段遇到删除继续跳过，以及浏览器 fixture 按实际请求头绑定项目。

原 run 随后因原角色进程的退出覆盖缺证而停在 `machine_evidence_pending`，并持续重复准备／恢复。2026-11-16 18:07（America/Los_Angeles）主会话撤销了这条故障后台执行，保留原始发现、修复与未知退出证据；不是用户要求停止任务，也没有将 RVF 结果改写为通过。

主会话已核对 20 个改动文件与上述修复候选逐字节一致，并在当前工作树重新完成 162 项针对性测试、7 项 Playwright、根项目和 Web UI typecheck、16 个源／测试文件的 Biome 检查及完整隔离构建。此后的仓库改动仅为本节验收说明。构建输出为 `~/.cline/kanban/task-validation-artifacts/27ba5/visited-task-navigation/build-distribution-after-rvf-fixes/`。

代码实现与前台验收完成；正式 RVF 完成状态仍不可声称通过，原 run 保留为 cancelled，原角色退出覆盖仍为 unknown。已有两项部署后观察仍待真实实例验证；未提交、同步或部署。

## 部署后验证登记

| 行为 | 部署前已证 | 真实实例待验 | 类型 |
| --- | --- | --- | --- |
| 历史、分支、上限、持久化、身份门禁与有界重试 | 单元／集成自动验证 | 无独立待验项 | 不登记重复验证 |
| 顶栏列表与 Backlog 复用 | 隔离浏览器覆盖桌面／320px | 完整 App 的项目切换、实时看板及浮窗上下文接线 | guided_manual |
| 终端快捷键 | 真实 xterm 与三种平台键位自动验证 | 真实 PTY／agent 输入及系统按键边界 | guided_manual |

调用 `cline-kanban-post-deploy-verification-authoring` 注册并查询确认 2 项定义；没有运行或勾选部署后验证。部署记录接入后预计挂载 0 个自动脚本、2 个引导观察项。无自动脚本，因此无旧实例 dry-run；无临时仓库插桩。

| verificationId | 观察断言 | assetsDir | 清理 |
| --- | --- | --- | --- |
| `027b8bc9-69bd-5bc9-a689-a027b3ec9ba4` | 真实实例跨项目历史导航正确定位任务并保留 Backlog 草稿 | `~/.cline/kanban/verifications/027b8bc9-69bd-5bc9-a689-a027b3ec9ba4` | automatic |
| `ea33fcd3-fe60-59a3-b678-002c2684148a` | 真实 PTY 内历史快捷键不会向 agent 发送输入 | `~/.cline/kanban/verifications/ea33fcd3-fe60-59a3-b678-002c2684148a` | automatic |

兜底人工清理命令：

```bash
kanban verification cleanup --verification-id 027b8bc9-69bd-5bc9-a689-a027b3ec9ba4
kanban verification cleanup --verification-id ea33fcd3-fe60-59a3-b678-002c2684148a
```

限制仍按批准方案：历史仅属于当前浏览器 origin，清除站点存储会清除记录；真实实例验证须在后续部署后完成。
