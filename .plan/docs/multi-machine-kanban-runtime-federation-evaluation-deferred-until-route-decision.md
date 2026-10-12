# 多机 Cline Kanban runtime 联邦 —— 评估与延期资产

> 状态：**不在 Cline Kanban 立项实现，停放到「四条路线评估」**（继续 Cline Kanban / 转 OpenRig / 基于 OpenRig 复现 / 自建编排）。
> 来源：任务 e6275（「远程访问改走 Tailscale HTTPS，修 Windows 剪贴板并加 Remote-SSH 打开」）的 Idea Development Decision，2026-10-12。
> 本任务只做「联邦友好」的远程访问修复：每台机器都能按同一配方暴露 HTTPS（`--additional-trusted-browser-origin` + `tailscale serve`），
> 本机专属功能（Open / openFile）收敛到 `web-ui/src/utils/resolve-project-filesystem-access-route-for-browser.ts` 一个判定函数里。
> 路线定为继续 Cline Kanban 之后，从下文的 Conservative（机器目录）起步。

## Capability

联邦之后，用户在任意一台机器的**一个浏览器标签页**里，可以看到并操作同一 Tailscale 账号下（或同一局域网内）其他机器上 Cline Kanban runtime 的 projects/tasks，不必给每台机器各记一个地址、各开一个界面。

## Before / After

### Before
- **单机内已经具备**：在一个 runtime 里，打开它管理的任意项目、任意任务，都能看终端和 diff，也能在终端里输入，还能在 All projects 面板里跨项目切换。联邦不改变这些单机能力。
- **缺的只是跨机器**：每台机器的 runtime 只看得见自己的项目。要操作另一台机器上的任务，必须记住那台机器的地址，另开一个标签页去访问它自己的界面。All projects、通知、Spotlight 搜索也都只覆盖本机。
- 项目身份里没有机器这一维，这是跨机合并的障碍：
  - `workspaceId` 取仓库目录名的 slug（`src/state/workspace-state.ts` 的 workspace id 分配），两台机器上同名的仓库**必然撞号**。
  - `taskId` 是 5 位 hex，跨项目本来就会撞号（前端已用 `${workspaceId}:${taskId}` 复合键）。

### After（只写相对现状的差量）
- 一个标签页的 All projects、通知、Spotlight 搜索里，同时出现其他机器的项目和任务，每一项带机器标识。
- 其他机器上的任务也能在这个标签页里直接打开，得到和本机任务**同样的**终端、diff、输入体验，不必跳到那台机器的地址。
- 只在本机生效的功能（Open、openFile、目录选择、添加项目）按「项目所属机器」正确路由，不会误在当前页面所在的那台机器上执行。

## 用户答复（2026-10-12）

- 推进方式：联邦友好 + 交路线评估。
- 机器集合，分长期与当下两层：
  - 长期：其他 Mac、Windows、Linux/无界面服务器都可能跑 runtime。联邦设计不能假设只有 macOS；Windows 先要移植，或者走 WSL。runtime 在 Windows 上**未经验证**（`.github/workflows/test.yml` 里 `windows-latest` 是注释掉的）。
  - 当下：只有 mac-mini 在跑。最短期的第二台机器是用户现有的 **MacBook**，同平台、零移植。

## Idea Validation

- **Gate 1（能力是否已实现）**：`fail`，明确不存在。仓库 grep（`federat|multi-host|multi-machine|peer runtime|remote runtime|多机|联邦`）无实现命中；历史计划只在 orca 对比里提到「远程/多机蓝图已 park」。
- **Gate 2（前提是否成立）**：
  - 网络可达 + HTTPS：成立。`tailscale serve` 与 `*.ts.net` 证书在 mac-mini 上已为 ccflare 启用。
  - 终端 WS 能被透明转发：成立。`src/terminal/ws-server.ts` 的 io/control 消息体不含 workspaceId，按 URL 改写后用原始 socket 管道转发即可。
  - 身份能在不迁移的前提下加上机器维度：中等可信。由聚合点生成限定 id 即可。
  - 其他机器能否运行 runtime：对「第二台 Mac」成立（`pass`）；对 Windows 主机仍是 `unknown`，要先移植。

## 参照：OpenRig、multica、orca 怎么解决多机问题

三家代表三种原型：

| | OpenRig（对等 daemon + 本机代理聚合） | multica（中心服务 + 外连执行器） | orca（桌面客户端聚合） |
|---|---|---|---|
| 数据在哪 | 每台机器一个完整 daemon（SQLite + API） | 只有中心服务（Go + Postgres + Redis，可用云或自托管）；daemon 无 UI、不对外提供数据 | 每台主机一个 runtime；聚合在 Electron 主进程 |
| 谁连谁 | 本机 daemon **入站**连其他机器（依赖 tailnet 互通） | daemon **只出站**：HTTP 轮询领任务，每 3 秒一次；WS 只用来「叫醒」，对 NAT 友好 | 桌面客户端连各 runtime 的 E2EE WebSocket，或走 SSH relay |
| 浏览器看到什么 | 浏览器只连本机 daemon，`?host=` 只读代理加扇出聚合（`AggregatedPayload{items, hosts}`，逐台给出可达状态） | 浏览器只连中心服务 | 浏览器版一次只能连一台机器，多机只在桌面版 |
| 机器怎么接入 | `hosts.yaml` 加手动配对：6 位码 + 人工批准，换来 bearer token；tailnet 视为认证边界，免 token | `multica login` 换一个 90 天 PAT；daemon 用持久 UUID 标识机器，自动注册到用户所在的全部 workspace；没有配对码 | 配对链接 `orca://pair?...`，每台设备一个可吊销的 token |
| 任务落到哪台机器 | 在哪台 daemon 上建，就在哪台 | 创建 agent 时必须绑定 runtime（机器 × CLI），没有自动调度，重试也不换机器 | worktree 归属哪台主机就在哪台 |
| id 撞号 | 各机器自己分配 id，再加 host 维度区分 | **全部由中心分配**（UUID + 每个 workspace 一个计数器），不存在撞号 | host 维度区分 |
| 远程交互深度 | 只读白名单，加一个写入动作；**远程终端和远程文件都不支持**（留给 MH-3/4） | **没有 PTY**：agent 一律以无头 stream-json 运行，只同步结构化 transcript（500ms 批量），回合制输入；没有文件和 diff 视图 | 桌面版通过 relay/RPC 支持远程 PTY 和文件读写 |
| 故障范围 | 逐台降级：一台掉线，只是看不到那一台 | 中心是单点：中心挂了全部停摆，运行中的 transcript 会丢；daemon 离线超过 45 秒，它名下的任务判失败 | 逐台降级 |

注：OpenRig 结论来自 `~/Documents/GitHub/openrig`（v0.4.6 起有 multi-host）；multica 结论来自本地快照 `3df95c8`（2026-05-01），之后的变化未核实；orca 来自 `~/Documents/GitHub/orca` 的 execution-host 实现。

**对 Cline Kanban 的含义**：
- Cline Kanban 的核心价值是浏览器里的**交互式 PTY TUI 会话**，每台机器的 runtime 也都持有完整状态。这和 OpenRig 的「对等 daemon + 本机代理」同构，和 multica 的「中心库 + 无头执行器」不同构。走 multica 路线，等于放弃 PTY 交互或另建隧道，同时还要新增一个中心库，代价最大。
- 在 Tailscale 下，入站可达性不是问题，所以 multica「只出站」的优势用不上。如果将来要支持没有 Tailscale、又在 NAT 后面的机器，可以借鉴它的「peer 主动外连聚合点」做反向隧道。
- id 撞号的解法：照 OpenRig 加 host 维度（限定 id），不照 multica 由中心分配，因为后者要迁移全部存量 id。
- 三家都没在**浏览器**里同时做到「多机聚合 + 远程 PTY」。这既是 Cline Kanban 联邦的差异点，也是它最难的部分。

## 架构耦合点（2026-10-12 核实）

- web-ui 有 132 处 tRPC 调用点，全部假设单源；nonce 是整页单例。
- `runtime-state-hub` 的握手要求「snapshot 必须是首条」，拼接多个 peer 的 state stream 时必须守住这条不变式。
- 终端 WS 鉴权现在只认 cookie（`src/server/runtime-server.ts` 的终端升级处），peer 间代理需要另加 bearer。
- **agent hooks 只回连本机 runtime**：联邦层只能代理 peer，不能在聚合点上替 peer 启动会话。
- 工作单元关系账本按机器各存一份，不能表达跨机关系。

## 方案变体

| 方案 | 形态 | 取舍 | 何时选 |
|---|---|---|---|
| Conservative：机器目录 | 每台机器各自用 Tailscale Serve HTTPS 跑（e6275 写成的「单机配方」）。kanban 增加「其他机器上的 Kanban」列表，手动配置，或探测 tailnet 上固定端口发现。点击后整页跳到那台机器的 origin，可选显示各机的任务计数（服务端去抓，只读）。约 1 个 PR | 便宜，所有拓扑都成立；但仍是「每台机器一个界面」，没有统一看板 | 只需要「一个入口找到所有机器」 |
| Balanced：服务端只读聚合 + 跳转操作 | 仿 OpenRig read-through：本机 runtime 登记 peer（共享密钥），把 peer 的项目、跨项目切换条目和通知并入 All projects，带机器徽标。打开 peer 的任务时整页跳到 peer 的 origin 去操作 | 统一的总览和通知；操作仍在对方界面；中等规模（peer 模块、id 命名空间改写、认证） | 主要诉求是「一处总览」 |
| Ambitious：完整服务端联邦 | 在 Balanced 的基础上代理 tRPC（约 84 个 workspace procedure 按请求头路由，约 66 个非 scope procedure 逐个裁定）、state stream 拼接，以及终端 WS 管道。web-ui 只需加「所属机器」字段做本机功能门控 | 其他机器的任务也能在本标签页里完整操作，体验等同本机任务；中到大，多个 PR；要处理契约版本漂移 | 确定长期留在 Cline Kanban，并且要在一个标签页里操作多台机器 |

浏览器端联邦（web-ui 直接连多个 origin）**不考虑**：要把「单源」假设从前端几乎所有数据路径里拔掉，还要每个 runtime 开放跨源访问并给浏览器发 token。OpenRig 和 orca 的浏览器版都没走这条路。

## 评估

| Axis | Rating | Evidence |
|---|---|---|
| User Pain | medium | 目前只有一台机器跑 kanban，痛点是预期中的，不是现实的 |
| Strategic Fit | low–medium | 路线未定，且 OpenRig 已有 multi-host |
| Evidence Strength | medium | 架构耦合点逐条核实；机器集合长期未定 |
| Feasibility | medium | 终端 WS 易转发；tRPC 和 state stream 的拼接是主要工作量 |
| Complexity | high | 跨 runtime-server、state-hub、终端升级、新 peer 模块、id 命名空间、认证 |
| Risk | medium–high | 新的 runtime 间认证面；`runCommand` 等于远程 shell，暴露面随机器数增加 |
| Differentiation | medium | 竞品都还没有「浏览器里的远程终端聚合」 |
| Maintainability | medium–low | 聚合点与 peer 之间的契约版本漂移需要握手或降级 |
| Testability | medium | 可以用两个 HOME 隔离的实例在单机模拟 |

## 决定

**ESCALATE → 停放到四条路线评估。** 理由：

1. 用户 2026-10-07 定过原则：「与平台绑定的实现推迟到路线定案」。联邦是重度平台绑定的投入。
2. OpenRig 已经实现了联邦的核心（服务端聚合），差的正是 Cline Kanban 擅长的远程终端。这本身就是路线评估里的一条关键对比项。
3. e6275 的远程访问修复对三种方案都是前置条件：每台机器都要 HTTPS 和受信 origin，Open 也要按「所属机器」路由。现在做不浪费。

## 最短期：第二台 Mac 零代码接入

e6275 落地后即可用，不需要额外代码：

- MacBook 照 `docs/remote-access-via-tailscale-serve.md` 的「单机配方」操作：本地跑 kanban（`--host 127.0.0.1`），加上 `--additional-trusted-browser-origin https://<macbook 的 ts.net 名>:<端口>`，然后 `tailscale serve --bg --https=<端口> http://127.0.0.1:<kanban 端口>`。
- 任何设备的浏览器访问 `https://<macbook>.ts.net:<端口>/`，剪贴板、Remote-SSH 打开都和 mac-mini 一样可用。Remote-SSH 深链的主机名取自页面主机名，每台机器的页面天然指向自己。
- 形态是「每台机器一个标签页」，没有统一看板。workspaceId 撞号不影响这个形态，因为两个 runtime 互不相见。
- MacBook 侧的 agent 登录、ccflare 等运行环境需要另行准备。

## Capability Contract（留给将来的蓝图任务）

- **身份**：聚合点生成限定 id `<peerId>~<workspaceId>`，对前端不透明；`RuntimeProjectSummary` 加上「所属机器 / 是否本机」。
- **认证**：经 tailnet 时 mesh 就是边界，可选再校验 `Tailscale-User-Login`；局域网时要求配置化的 peer 共享密钥。终端 WS 也要认 bearer。
- **本机专属功能路由**：扩展 `resolve-project-filesystem-access-route-for-browser.ts` 的输入（加「项目所属机器」），调用点不用改；Remote-SSH 深链的主机名改用项目所属机器的可达主机名，用户名取该机器广播的 `runtimeHostRemoteEditorAccessIdentity`。
- **agent hooks** 只回连本机 runtime；**关系账本**跨机关系列为非目标或单独设计。

## 相关任务

- 25e0d（backlog）：「通过 Local Tailscale 共享 / 从其他设备进行 Cline Kanban 工作」，倾向 Electron App + 跨设备同步状态。与本评估同一主题；路线评估时两者一起看。Electron 方向对应上文 orca 原型（客户端聚合）。

## Non-Goals（e6275）

- 不实现任何联邦机制（peer 登记、代理、聚合、限定 id）。
- 不移植 runtime 到 Windows。
- 不处理局域网无 Tailscale 时的 token 认证。
