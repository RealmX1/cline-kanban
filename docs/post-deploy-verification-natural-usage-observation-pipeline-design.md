# 设计：在自然使用中程序化观察，由多模态 agent 判定 Post-Deploy Verification

状态：设计稿（2026-10-11）。本期（任务 483b6）只交付输入数据：待观察记录和只读出口。pipeline 本身另建任务实现。
相关：`docs/post-deploy-verification.md`（现行机制）、任务 7b61b 的 29 项盘点、任务 9efe4 的 PiP 悬浮窗（`7cd3fc60`，未合并）。

## 1. 目标与边界

用户的判断（2026-10-11）：UI 类断言理论上也无需用户自己观测。多模态 coding agent 已经足以看懂截图和 DOM，缺的是一条 pipeline：在合适时机**程序化捕捉情境**，交给 agent 判定，再把判定与证据归档。非 UI 类断言则由临时挂载的脚本全自动监测，到时机就自动完成验证，并自动清理、归档。

- **与 E2E 的边界**：PDV 是「在自然使用中逐步核验、一次性验收」。它不主动构造场景，只在真实使用恰好走到断言相关位置时取证。严谨性不如 E2E，也不是每次都重跑的回归测试。「给 E2E 接入多模态判定」不在本设计范围内。
- **不做**：替用户操作 UI；在用户没走到的地方伪造场景；把判定结果当作「通过」写进 `verifiedAt` 之外的其他完成证据。

## 2. 输入

1. **待观察记录**：`~/.cline/kanban/post-deploy-verification-deferred-natural-usage-observation-records.json`。用户以「触发时机随机 / 罕见，转为在自然使用中观察」结案的未勾项。每条记录带：
   - 断言 `assertionLabel`；
   - `guidanceSnapshot`：steps / expectedObservation / failureSignature / **anchor**；
   - `automatedScriptSnapshot` 与保留的资产目录 `retainedVerificationAssetsDirectory`；
   - 来源部署与 commit。
2. **活跃部署组里仍未勾的项**（可选的第二阶段）：同一套机制也能在结案前帮用户勾选。
3. **anchor 注册表**：`web-ui/src/components/post-deploy-verification/verification-anchor-registry.ts`。目前已有的键：
   - `board-task-card:<taskId>`
   - `board-column:<columnId>`
   - `task-detail:<taskId>`
   - `verification-panel-task:<taskId>`

## 3. 两条通道

### 3.1 UI 断言：捕捉 → 多模态判定

- **触发**：web-ui 侧用一个观察器（`IntersectionObserver` + `MutationObserver`）盯「有待观察记录指向的 anchor」。目标元素挂载且可见、并稳定一段时间（防抖，避免动画中途取证）后，生成一次捕捉。同一记录设节流，例如每 30 分钟最多一次，拿到确定结论后停止。
- **捕捉内容**（一个捕捉包，写进 `verifications/<verificationId>/natural-usage-observations/<捕捉时刻>/`）：
  - anchor 元素及其上下文的截图：
    - 桌面壳（`packages/desktop`）里用 Electron `webContents.capturePage(rect)`，静默、无需授权、像素准确；
    - 纯浏览器里退化为 DOM 转图（如 `html-to-image` 一类维护良好的库，先评估再选）。不用 `getDisplayMedia`，它每次都弹授权框。
  - anchor 子树的 DOM 片段与关键计算样式（z-index、可见性、溢出）。这次修的「按钮被挤出卡片」就是计算样式能直接判定的类型。
  - 视口尺寸、路由、相关任务 id、运行时版本（deploymentId / commit）。
  - 隐私：只截 anchor 外接矩形加一圈边距，不截终端面板（可能有密钥），截图前对已知敏感区域打码。
- **判定**：runtime 调度一个短命的多模态 agent 作业（可复用 exploration-thread-graph 作业的成本闸思路：模式 / 防抖 / 单飞 / 节流），输入捕捉包和 `expectedObservation` / `failureSignature`。输出 `{ verdict: passed | failed | inconclusive, rationale, evidenceRefs }`，写回同一目录的 `verdict.json`。
- **成本闸**：每次判定都是一次多模态模型调用。按记录节流、按天封顶，`inconclusive` 连续多次后降频。参考 `docs/agent-session-fork-prompt-cache-measurements.md` 的计量方法先实测单次成本。

### 3.2 非 UI 断言：临时挂载脚本自动监测

- **部署后自动跑一次**：`kanban deployment record` 之后，runtime 对新组里的 `automated_script` 项自动运行。现在只有手动运行入口（`deployment.runPostDeployVerificationItem`）。
- **事件触发**：脚本可声明它关心的 runtime 事件（如某类 hook、某个 procedure 被调用），runtime 在事件后运行。最小实现是定时重跑，带退避。
- 通过即自动勾选（现有不变量：automated 项的 checked 只由运行结果驱动）。

## 4. 判定之后

- **passed**：
  - 待观察记录转为终态（新枚举值，例如 `observed_in_natural_usage_and_confirmed_by_multimodal_agent`）；
  - 追加一条账本事件，例如 `post_deploy_verification_deferred_item_confirmed_in_natural_usage_observed`，**不**改写原结案；
  - 按原定义的 cleanup 模式清理资产，并注销定义。
- **failed**：通知用户（复用通知中心），附捕捉包链接；提议把任务从 Done 恢复或新建修复任务，交给用户决定，不自动动卡。
- **inconclusive**：保留记录，降频继续观察。
- **归档与过期**：
  - 捕捉包与 verdict 是证据，长期保留，按记录归档；
  - 定义和资产在记录终态后按 cleanup 模式处理；
  - 长期没有触发的记录（如 90 天）提示用户「改为手工核对」或「放弃」。

## 5. 与 7b61b 29 项盘点的对应

| 盘点项 | 本设计的覆盖 |
|---|---|
| #2 能自动的优先自动化 / #6 自动验证实时显示输出 | 3.2 |
| #3 用户使用相关功能时出现引导 / #4 现场引导与面板联动 / #5 锚点找不到时降级 | 3.1 的触发（不再需要用户观察，引导降为可选的「我也看一眼」） |
| #12–#14 独立验证窗口 | 不依赖；判定结果在面板和通知中心呈现即可 |
| #27 录制并重放验证操作 | 捕捉包就是录制的最小形态；重放不在本设计范围 |
| #28 验证者否定 agent 写的自动测试 | 判定为 failed 时的处理路径（第 4 节）可以复用 |

## 6. 分期建议

1. **P1**：部署后自动跑一次 automated 项（3.2 第一条）。纯 runtime，风险最低。
2. **P2**：web-ui 观察器加桌面壳 `capturePage` 捕捉，只归档、不判定，用来人工抽查捕捉质量。
3. **P3**：多模态判定作业加成本闸，结果回写与账本事件。
4. **P4**：浏览器端捕捉退路、事件触发的脚本、过期与归档策略。

## 7. 待定问题

- 多模态判定用哪个模型、走哪个通道（复用 task agent 的 harness，还是直接调 API）。
- 捕捉包长期保留的体积上限与清理策略。
- 判定为 failed 时是否允许自动把任务移回 Validation。默认不允许，只提议。
