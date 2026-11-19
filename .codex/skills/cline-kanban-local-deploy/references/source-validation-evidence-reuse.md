# 本地部署的源码验证证据交接

标准部署从已经绑定本次候选的上游回执提取原件入口，将绝对文件路径写入准备请求的可选 `sourceValidationEvidenceFilePaths`。当前支持以下入口。

| 上游材料 | 可传入的原件 |
| --- | --- |
| base-branch-sync 持久交回 | 原操作的 `operation-state.json`，其中的 `validationRecords` 带逐项原件路径及摘要；也可传所属操作的 `current-tree-validation.json` |
| RVF 原生验证 | 已绑定 run 的 `run.json` 或相邻 `validation.json`；工具核对冻结命令、逐项执行与退出记录和原日志摘要 |
| 备用完整树交回 | `commit-and-base-branch-sync-result.json` 或相邻 `final-complete-tree-verification-evidence.json`；原件清理后可使用同摘要的持久审核副本 |

交回采用 RVF 结果时，从该次 RVF 验收交接转交原 run 入口。只转交已有原件，保留记录上的仓库、候选树和命令。部署按这些精确路径及其受约束的原件引用读取；引用缺失、报告不可读、旧格式缺证或候选环境不匹配时，从隔离候选补跑缺项。

## 五项检查与证据判据

- 冻结计划保存实际 `argv`，涵盖运行时与 Web 的类型检查、各自测试以及源码 lint。只执行本次计划中的命令。等价的 npm 调用须解析到服务 Node 绑定的 npm 入口。`test:precommit` 与 staged lint 的覆盖范围受原命令限制。
- 比较同仓库、完整源码树与工作目录内容，核对命令、环境、预检、退出原件及摘要。merge 后树不同即补验。已证实的同树质量失败持续阻断，直到有兼容的同项后续成功证明。RVF 的明确缺工具退出保留原失败，按验证环境不可用补验。
- 报告保留每项复用、补跑或待证结果、原件摘要和持久副本。有效进程环境只保存摘要。工具独立冻结，随执行目录恢复。依赖或候选相关证据变化时复核，只补尚缺的项。
- 独立观察可用随包工具的 `--inspect-only`，按需重复传 `--source-validation-evidence-file-path <绝对路径>`。标准启动自动生成五项计划和调用参数。构建、原生 ABI 与真实实例验收由后续阶段分别核验。
