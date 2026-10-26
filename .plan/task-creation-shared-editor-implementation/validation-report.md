# 共享任务编辑器实施验证

本文记录 Task `ce03f` 首次实施完成时的部署前验证快照，表内数字不包含后续评审修复。行为与存储说明见 `docs/task-editor-floating-window-and-project-assignment.md`。后续独立评审、修复、最终验证、提交与本地 base 整合的真实结果，统一保存在 `/Users/bominzhang/.rvf/user-local-data/run-logs/runs/rvf-review-start-b9fbd7e9d3b6ef96/artifacts/user-authorized-manual-continuation/handoff.md`。

## 部署前结果

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 运行时 guarded 测试 | 14 文件、204 项通过；策略与仓库变更 canary 通过 | 配置落盘、单轮执行器、关系身份投影、迁移往返与中断恢复、既有查卡流程 |
| Web 单元测试 | 9 文件、157 项通过 | 共用编辑器、草稿恢复、异步提交、剪贴板迟到结果、显示偏好、分析失败选择、Settings |
| Playwright | 3 项通过 | 桌面拖动与背景焦点、手机宽度、折叠隐藏、快捷键归属、剪贴板预选和已有关系编辑保护 |
| 类型检查 | 根项目与 Web 通过 | 两个独立 tsconfig；Web 构建再次执行类型检查 |
| 打包构建 | 通过 | Vite 与运行时 esbuild；输出隔离在本工作区 |
| 共享产物隔离 | 主仓两处文件清单及 SHA-256 不变 | 主仓 `dist` 30 个文件、`web-ui/dist` 18 个文件 |

全部原始日志、后续 Backlog 创建及关系登记回执和部署后资产来源持久保存在 `/Users/bominzhang/.cline/kanban/task-implementation-evidence/ce03f/`。运行时测试使用 Node 24，与共享原生依赖 ABI 一致；没有重建共享依赖。

## 部署后断言分析

| 行为 | 部署前已证 | 部署后待验 | 类型 |
| --- | --- | --- | --- |
| 浮窗与关系剪贴板预选 | 真实浏览器受控接口下的布局、焦点、拖动和预选；异步竞态单测 | 实际打包页面的层级与真实浏览器剪贴板权限链路 | guided_manual |
| 三态设置偏好 | 控件值保留、逐键合并、配置文件重载；创建与编辑共用 | 实际客户端之间及自然重新部署后仍能读回相同偏好 | guided_manual |
| 全局 AI 设置与新增偏好契约 | 类型检查、隔离 CLI 集成与配置测试 | 当前真实运行实例已提供新 procedure 和偏好字段 | automated_script |
| 迁移身份、往返与中断恢复 | 隔离 HOME、Git 与真实关系账本的集成测试 | 不另造真实用户任务验证；不注册重复项 | 无新增项 |

## 已注册验证

| verificationId | kind | 断言 | assetsDir | cleanup.mode |
| --- | --- | --- | --- | --- |
| `4a3175b3-a7fd-4f9f-aefc-b07d2d8ebb01` | automated_script | 真实运行实例提供全局 AI 分析设置与三态任务编辑器偏好 | `/Users/bominzhang/.cline/kanban/verifications/4a3175b3-a7fd-4f9f-aefc-b07d2d8ebb01` | automatic |
| `7ee88a55-6174-4a2a-90fe-d23fb86e696e` | guided_manual | 真实浏览器中浮窗可切换背景焦点，原生剪贴板只预选关系对象 | `/Users/bominzhang/.cline/kanban/verifications/7ee88a55-6174-4a2a-90fe-d23fb86e696e` | automatic |
| `4c50e835-2d08-476c-bcca-326d42d05ac5` | guided_manual | 跨客户端与自然重新部署后，创建和编辑共用设置显示偏好 | `/Users/bominzhang/.cline/kanban/verifications/4c50e835-2d08-476c-bcca-326d42d05ac5` | automatic |

自动脚本已在旧运行实例 dry-run：以退出码 1 明确报告 `support.getGlobalExecutorSettings` 返回 HTTP 404，符合旧实例尚未部署的状态。只执行两次只读 GET，没有崩溃、超时或用户数据残留。脚本入口已复制到注册返回的资产目录，不依赖 task worktree。

`verification list` 自查摘要为 `{"ok":true,"taskId":"ce03f","count":3,"kinds":["automated_script","guided_manual","guided_manual"]}`。实际部署并记录 deployment 后，本组预计挂载 1 项自动验证、2 项浏览器观察；本次没有执行部署，也没有把旧实例的失败记为通过。

## 兜底清理

验证完成后支持自动清理。需要人工清理时，逐条执行：

```bash
kanban verification cleanup --verification-id 4a3175b3-a7fd-4f9f-aefc-b07d2d8ebb01
kanban verification cleanup --verification-id 7ee88a55-6174-4a2a-90fe-d23fb86e696e
kanban verification cleanup --verification-id 4c50e835-2d08-476c-bcca-326d42d05ac5
```

本次没有加入验证专属源码插桩。可用 `rg 'KANBAN-VERIFICATION-SCOPED:' src web-ui/src` 扫描既有标记；不要据此移除其他任务的插桩。

后续 Backlog 已创建：`24b78` 研究 Decision Model，`8aa51` 建设警告与错误持久观察入口。
