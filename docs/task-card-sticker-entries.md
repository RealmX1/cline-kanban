# Task Card 多便签

便签与 `taskCommentEntries` 独立，旧卡片没有便签字段时视为空。不迁移评论；首版仅支持多行纯文本，不含附件、颜色或拖动排序。

## 交互与共享入口

`TaskCardBody` 统一接入 `useTaskCardStickers` 和 `TaskCardStickers`，因此主看板、Focus View、置顶板、跨项目卡片和关系预览共用行为。

- 有便签时，卡片底边显示绝对定位的「便签 N」stub，卡片高度和相邻元素位置不变。
- 悬停整张卡片打开浮层；鼠标离开卡片及浮层后延迟 200ms 关闭。编辑与保存期间保持打开，失败保留草稿并提供重试。
- 新便签默认展开；逐张收起只显示首行。再次悬停、刷新、切换浏览器或重启运行时均使用服务端保存的折叠状态。
- stub 支持键盘和触屏打开；Escape 关闭，显式打开时可归还焦点。悬停不抢夺原输入焦点。
- 同一浏览器只挂载一个便签浮层；正在编辑或保存时，其他卡片的悬停不抢走它。Radix Portal 避开父元素裁切，空间不足自动翻到上方，长内容内部滚动。
- 便签浮层显式声明 `aria-modal=false`。仓库的关联预览会检查当前模态窗口，缺少此声明会使悬停便签阻挡「查看关联任务」。
- 永久删除的历史卡片只读取随历史快照保留的便签，可在本地展开阅读，不向同 ID 的活动任务写入。

历史卡片沿用永久删除前关系账本的字段快照读取便签，不查询同 ID 的活动任务。缺少便签字段或正文损坏的旧快照按空便签展示；历史卡的展开与收起只保留在本地，关闭后不写服务端。

## 服务端契约与持久化

`RuntimeBoardCard.taskStickerEntries` 保存 `taskStickerEntryId`、`stickerText`、`isCollapsed`、`createdAt`、`updatedAt`。`taskStickerDeletedEntryIds` 仅保存删除条目的 ID，阻止迟到创建重试复活已删除便签，不保留删除正文。

`taskCardAction.applyTaskStickerEntryMutation` 的连接 scope 指定 workspace；请求必须携带 `taskId`、`expectedTaskIncarnationCreatedAtEpochMs` 和 `mutation`。响应提供 `boardWasSaved` 与完整的 `taskCardSnapshotAfterAction`。

| operation | 必填操作字段 | 行为 |
| --- | --- | --- |
| `create` | `taskStickerEntryId`, `stickerText` | 客户端生成 ID，并在重试中复用；已有或已删除的 ID 不重复创建 |
| `update_text` | `taskStickerEntryId`, `expectedStickerText`, `stickerText` | 比较最新正文，冲突返回 `CONFLICT`；相同结果的重试不重复写盘 |
| `delete` | `taskStickerEntryId`, `expectedStickerText` | 不删除别人刚修改的正文；重复删除无副作用 |
| `set_collapsed` | `taskStickerEntryId`, `isCollapsed` | 单独设置折叠，不覆盖正文；相同状态不重复写盘 |

操作经按任务串行器进入最新 board 的文件锁，先校验任务代际，再只修改目标条目。整板 `saveState` 在同一文件锁内保留已持久化的便签和删除 ID，避免旧客户端快照覆盖服务端事实。水合白名单、前后端类型和全字段往返夹具同步覆盖这两个字段。

正文冲突后，UI 显示最新正文并保留原草稿；用户明确核对后才能基于新正文继续保存。创建已落盘但响应丢失时，后续修改的草稿也不会被幂等回执静默清掉。异步响应同时检查 workspace、任务 ID、任务创建时间及组件生命周期代次，覆盖 A→B→A 的切换。

便签变更不推进任务 `updatedAt`、`taskDescriptionLastUpdatedAt`、会话活动时间或已读状态。Hover 只读取，不保存折叠状态。

## 验证与复现

根项目经 `test:guarded` 验证纯变更、真实卡片动作、路由、文件锁及持久化。Web UI 单元测试覆盖水合、失败草稿、迟到响应、历史只读和原有卡片/评论行为。Playwright 覆盖布局不变、翻转、裁切、鼠标跨入、增删改、键盘、触屏、嵌套预览、真实关联入口及拖拽。

初步实现阶段：58 项 guarded 测试（含打包态重启）、168 项相关 Web UI 单元测试及 17 项浏览器测试通过；两端类型检查、Biome 与隔离构建通过。更大范围回归中的既有测试桩失败单独记录在下文，没有计入通过数。

后续 RVF 修复覆盖长正文编辑器的浮层内滚动、按鼠标/键盘/触屏来源处理关闭、失败操作精确重试，以及永久删除历史便签的真实读取链；新增了对应回归。最终候选的验证结果以本轮 RVF handoff 和结构化验证记录为准。

```sh
npm run typecheck
npm run web:typecheck
npm run test:guarded -- --project precommit-safe --project runtime-integration \
  test/runtime/core/task-sticker-entry-mutation.test.ts \
  test/runtime/trpc/task-card-action-api.test.ts \
  test/integration/task-sticker-entry-persistence.integration.test.ts
npm run web:test -- src/hooks/use-task-card-stickers.test.tsx src/state/board-state.test.ts \
  src/components/board-card.test.tsx src/components/task-card-body.render-role.test.tsx \
  src/components/task-card-body.visual-density.test.tsx src/components/task-comments-dialog-provider.test.tsx
npm --prefix web-ui run e2e -- tests/task-card-stickers.spec.ts tests/task-card-quick-actions.spec.ts --workers=1
```

打包态重启测试额外启动两个独立浏览器上下文，核对真实 WebSocket 更新，再强制结束运行时、重启并用全新浏览器恢复正文与折叠状态。它只使用隔离 Git fixture、HOME、Codex 配置及数据库，不启动 Agent。先按根 `AGENTS.md` 隔离构建输出，再执行：

```sh
PLAYWRIGHT_BROWSERS_PATH=<已安装浏览器的缓存绝对路径> \
KANBAN_RUN_TASK_STICKER_PACKAGED_BROWSER_RESTART_TEST=1 \
KANBAN_TASK_STICKER_PACKAGED_BROWSER_EVIDENCE_DIRECTORY=<持久证据目录> \
npm run test:guarded -- --project runtime-integration \
  test/integration/task-sticker-packaged-browser-runtime-restart.integration.test.ts
```

本机共享 `better-sqlite3` 以 Node 24 ABI 137 编译；构建及打包态测试使用同一 Node。默认 shell 的 Node 22 ABI 127 无法加载它，不能为此重编共享依赖。

扩大回归时发现 `board-card-render-isolation.test.tsx` 的 `Droppable` 桩没有传第二个 snapshot 参数，既有折叠列读取 `isDraggingOver` 时失败；在本任务初始 HEAD `8ddb05d6e34d8aef78dfe6aece7119f8ce930410` 的独立 worktree 已复现相同失败。本任务不修改该相邻测试问题。

## 部署后验证

| 行为 | 部署前证据 | 真实实例待核对 | 类型 |
| --- | --- | --- | --- |
| 逐条操作、并发、代际和重试 | guarded 纯函数、真实路由及文件锁测试 | 无新增人工核对 | 不注册 |
| 跨浏览器同步与进程重启恢复 | 打包态隔离双浏览器及强制重启 | 无新增人工核对 | 不注册 |
| 实际部署的前后端契约一致 | 本任务隔离构建通过 | 真实 Web bundle 含便签契约且写入路由存在 | `automated_script` |
| 当前真实布局的叠层和点击 | Playwright 覆盖标准/紧凑/置顶/嵌套及触屏 | 当前已打开面板和固定前台窗口周围的实际层级 | `guided_manual` |

已给 task `f2e33` 登记 2 项，均为 `cleanup.mode=automatic`；部署记录匹配本任务后预计挂载 1 项自动验证和 1 项引导验证。

- `e8c337a1-a511-4470-b5ca-388e7c4d8efd`：真实运行实例同时提供便签写入路由与包含便签契约的 Web bundle。资产目录 `~/.cline/kanban/verifications/e8c337a1-a511-4470-b5ca-388e7c4d8efd/`，入口 `verify-live-task-sticker-contract.mjs`。只读哨兵请求不写入任务；旧实例 dry-run 正常返回未包含新契约，无 crash、超时或残留。
- `a3e5d017-2213-4c03-a0ae-a12852624fff`：真实实例的 Focus View、置顶板和关系预览中便签浮层完整可点击，卡片与相邻元素位置不变。资产目录 `~/.cline/kanban/verifications/a3e5d017-2213-4c03-a0ae-a12852624fff/`，定位锚点 `board-task-card:f2e33`。

`kanban verification list --task-id f2e33 --project-path <主仓库路径>` 已确认仅有以上两项；未执行部署或把待验证项勾为通过。没有 repo 插桩。必要时清理：

```sh
kanban verification cleanup --verification-id e8c337a1-a511-4470-b5ca-388e7c4d8efd
kanban verification cleanup --verification-id a3e5d017-2213-4c03-a0ae-a12852624fff
```
