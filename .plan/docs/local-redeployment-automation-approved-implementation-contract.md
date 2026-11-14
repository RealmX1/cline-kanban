# 本地重部署自动化实施合同

状态：`PLAN-READY`。用户已批准此前重新提交的《本地 redeploy 全流程脚本化与按需 Agent 介入》，并于 2026-11-13 明确要求 `Implement the plan.`、`readthe plan again if not in your context, and proceed with the work.`。本文保留该批准范围，不产生生产部署授权。

## 能力与边界

一次已授权 redeploy 从候选准备到验收由脚本执行，覆盖在线与离线起点。复用现有八阶段 producer 和通用所属监督进程；机器等待自动补证，真实修复或判断才交回 Agent，正常成功仅交回一次轻量终审。

不包含源码同步、远端操作、新调度器、生产部署、自动回滚或旧执行重放。旧 v1 manifest 与冻结执行器保持原样。

## 实现切片与验收

1. 标准入口与执行归属：增加 `prepare-redeployment`、`start-redeployment`；在构建前冻结请求、Node、候选 commit、目标、授权来源及工具摘要。在线通过所属执行登记，离线复用独立 supervisor；恢复后 `adopt-existing-supervisor` 核对材料、真实任务与会话 incarnation、工作树实体和原生监督身份，不再次派发。无可信会话归属的外部调用只返回持久结果。
2. 标准阶段与恢复：私有源码、依赖和构建输出；复用源码检查证据；生成八阶段命令与观察器。v2 明确在线进程、已证离线与未知基线，不伪造 PID。保全配置、数据库、任务映射、worktree 和 staged/unstaged/untracked 内容；逐项持久核验与失效，API 超时使用一致性持久快照，只补缺项。未知副作用先核验；部分发布按原清单补齐。Stop、错误身份与授权错配禁止相关动作；语义预算跨重启保留。
3. 接管证据与端到端：在真实会话接受点保存绑定 runtime/session 代际的持久回执，部署绑定候选和产物。历史接受、当前状态、后续资格与自然 I/O 分开。离线由实际存活执行者调用绑定服务入口恢复；单实例锁、保留 tmux 原 pane。机器重启后由已有服务或显式恢复入口继续，不承诺无服务时凭空自启。

## 影响面与风险

部署独立 CLI、manifest、标准阶段；通用所属执行 schema/service/router/CLI；会话接管接受点；构建入口、测试、local-deploy skill、执行合同及原统一图。通用模块已有 main 后续修复及 sibling d94f7 WIP，只做必要增量，不覆盖他人代码。

主要风险是重复副作用、WIP 遗失、伪造归属、旧执行被新代码改写、正常回收误判历史接管。对应测试必须拒绝错 candidate/task/worktree/PID/material，验证持久 Stop、原件保留、幂等接受与最终交回。

## 验证

先写失败测试再实现各切片。五条代表部署轨迹作为隔离场景，不重放真实部署；覆盖构建前中断、发布后退出、runtime/boot 代际改变、离线启动失败、活 tmux pane、existing-supervisor 接管和局部补证。使用 Git fixture、HOME/CODEX_HOME 隔离、guarded tests；类型检查、lint、隔离 build（显式输出目录）和 Node 22/实际服务 Node 验证。收尾注册 PDV，更新同一统一流程图。

完整模型成本和停机时长须有原生实测；缺失保持未知，不用命令数推算。
