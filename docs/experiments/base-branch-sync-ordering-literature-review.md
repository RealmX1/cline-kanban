# Git / worktree 合入排序：文献与实践调研

任务：f8bd4。成文时间：2026-11-01 UTC；本地时区为 America/Los_Angeles。

本文保存本任务前几轮的定向文献调研与只读环境调查，作为后续实现的依据。它不是穷尽式 systematic review，也不是已完成的实验报告。当前没有创建实验备份、脚手架、原生分身或模型计量回合，没有提交、同步、推送、部署或修改候选任务。

相关文档：[排序实验设计](base-branch-sync-ordering-experiment-design.md)、[完整整合方法设计与 roadmap](base-branch-sync-integration-method-experiment-roadmap.md)。

## 1. 用户问题与有效范围

用户希望将等待 commit / base-branch-sync 的任务组成一批，通过先验分析调整整合顺序，主要评价：

1. 整批任务完成整合的速度，优先级最高。
2. 整合过程中消耗的 Agent Token。
3. 尽可能发现并验证跨任务冲突，包括代码能自动合并但意图、接口或行为互不兼容的问题。

用户提出在备份的看板、会话及 worktree 上做对照，正式实验可等待当时正在进行的候选完成 RVF。d55ee 明确排除。

后续交互已经确认：

- 纳入隔离副本中的冲突验证和受控修复。
- 本次实际实验先评估排序本身的增益；完整整合方法只做设计和 roadmap，待吸收本轮经验后再设计完整实验。
- 先预实验取得实际耗时与 Token，再确定正式对照规模；尚未确定正式重复次数与总预算。
- 每个任务负责整合的 Agent 从该任务原会话的冻结位置原生 fork；负责分析排列的 Agent 使用新会话。
- 保留 Git、GitHub 和 worktree；Scion、DeltaDB 暂不深入讨论，不为实验迁移到 Jujutsu。

用户本轮指令是“请你先将先前的调研结果成文;而后停下来，我会 compact context，由你开始实现”。因此当前交付截止于文档与持久交接；成文后等待用户接续，不自行进入实现。

## 2. 研究问题拆分

| 问题 | 输入与作用 | 不能混淆的结论 |
| --- | --- | --- |
| 合入排序 | 固定的一批改动，决定整合先后 | 某个时段通过更多 PR，不代表同一批全部完成更快 |
| 推测式验证调度 | 选择哪些未来组合值得提前构建、测试 | 更多并行可能降低等待，也可能增加废弃构建与计算成本 |
| 跨任务冲突检测 | 判断改动组合是否破坏接口、行为或需求 | 文本可合并、编译通过与意图兼容是不同性质 |
| 冲突修复 | 修改组合实现，保留应共同满足的需求 | 生成不同修复本身也会改变成本与最终质量 |

本轮没有找到同时覆盖上述问题与 Agent Token 优化的统一综述。这是本轮检索的发现，不能写成该类研究绝对不存在。

## 3. 综述与系统映射

### S01：Software Merge: A Two-Decade Systematic Mapping Study

- 作者：Carlos Eduardo Carbonera、Kleinner Farias、César Augusto Graeff、Robson Keemps Silva。
- 出处：SBES 2023，[DOI 10.1145/3613372.3613391](https://doi.org/10.1145/3613372.3613391)。
- 方法与范围：以 PRISMA 指导系统映射，分析九个研究问题，从 308 项筛选阶段候选中选出 70 项研究。摘要报告 71.42% 的纳入研究评价语法层面的冲突。
- 阅读状态：已核对书目和摘要；ACM 正文请求返回 403。补读了[作者 2024 年 ProMerge 学位论文](https://kleinnerfarias.github.io/pdf/master-dissertation/dissertation-carlos-2024-1.pdf)第 3 章的扩展文献回顾，其表 6 同样列出 70 项研究的分类。学位论文不能无条件替代会议版的全部细节。
- 对本任务的价值：作为软件合并研究地图，检查分类和评价遗漏；不能由“纳入 70 项研究”推出已有最优排序器或完整语义冲突检测能力。

### S02：On the Prediction of Software Merge Conflicts: A Systematic Review and Meta-analysis

- 作者：César Augusto Graeff、Kleinner Farias、Carlos Eduardo Carbonera。
- 出处：SBSI 2023，[DOI 10.1145/3592813.3592931](https://doi.org/10.1145/3592813.3592931)。
- 方法与范围：摘要说明采用 PRISMA，梳理软件冲突预测研究。
- 阅读状态：已核对书目和摘要；ACM 正文请求返回 403，尚未完整获取。没有据此引用其未读的纳入数量、模型排名或汇总效果。
- 对本任务的价值：最贴近先验预测信号的综述入口；后续如需复用具体特征或效应，必须取得相应正文或原始研究。

### S03：A State-of-the-Art Survey on Software Merging

- 作者：Tom Mens。
- 出处：IEEE TSE 28(5)，449–462，2002，[作者机构书目页](https://researchportal.vub.be/en/publications/a-state-of-the-art-survey-on-software-merging/)，DOI 10.1109/TSE.2002.1000449。
- 内容：比较文本、语法、语义及基于操作的合并路线。
- 阅读状态：核对了书目及摘要级内容；未完整阅读其原始全文。
- 对本任务的价值：建立基础术语，不作为当前 Agent 工作流性能的直接证据。

### S04：Conflict management techniques for model merging: a systematic mapping review

- 作者：Mohammadreza Sharbaf、Bahman Zamani、Gerson Sunyé。
- 出处：2022-10-16 在线发表，Software and Systems Modeling 22，1031–1079，2023，[出版社页面](https://link.springer.com/article/10.1007/s10270-022-01050-9)。
- 内容：从 1,800 多项初始候选中分析 105 篇，覆盖 2001 至 2021 年中，建立冲突管理分类。
- 阅读状态：出版社摘要及书目；未完整获取订阅正文。
- 对本任务的价值：可借鉴约束违反、变化重叠和模式匹配等分类。这里的 model 是软件建模工件，不是 LLM 权重；不能直接把其结果迁移到 TypeScript 代码整合。

## 4. 直接相关的方法论文与工程实践

### S05：PRioritize——基于构建成功概率调整 PR 顺序

- 文献：Maximilian Jungwirth、Martin Gruber、Gordon Fraser，Improving Merge Pipeline Throughput in Continuous Integration via Pull Request Prioritization，ICSME 2025 Industry Track，[开放全文](https://arxiv.org/html/2508.08342v1)。
- 方法：使用历史构建结果、PR 元数据及上下文预测构建成功概率，优先处理更可能通过的 PR；比较 FIFO、改动行数、文件数及历史失败等启发式。
- 评价：同时使用队列快照和包含重置行为的流水线模拟；训练与测试按时间分开，避免未来信息泄漏。模拟主要统计工作时段吞吐量。
- 重要发现：简单按修改行数或文件数排序没有稳定优于 FIFO，部分结果更差。排序的直觉不能直接当作收益证据。
- 迁移限制：BMW 的工业上下文与持续到达的 PR 流，与我们的一次性冻结批次不同。不能把延后失败 PR 获得的时段吞吐提升直接解释成整批总耗时下降。
- 阅读状态：已阅读开放版本的方法、对照和有效性威胁相关部分。

### S06：SubmitQueue——预测耗时、选择推测路径与限制预算

- 文献：Dhruva Juloori 等，CI at Scale: Lean, Green, and Fast，ICSE 2025，[论文与版本信息](https://arxiv.org/abs/2501.03440)。本轮阅读了 v1 开放全文并核对 v2 摘要与会议出处。
- 方法：把成功概率、构建耗时及绕过资格纳入推测任务优先级；用 speculation threshold 减少不会用于实际落地的构建。
- 报告结果：在 Uber 的 Go、iOS、Android monorepo 中，资源使用约下降 53%、CPU 约下降 44%、P95 等待约下降 37%。这是作者的工业运行报告，不是我们场景的收益估计。
- 对本任务的价值：排序、推测深度和计算预算需要一并计量；不能只统计缩短的等待而忽略废弃工作。

补充实践：[Bypassing Large Diffs in SubmitQueue，2023](https://www.uber.com/jp/en/blog/bypassing-large-diffs-in-submitqueue/)。其绕过论证依赖 hermetic 构建、确定性测试、内容身份和相应路径覆盖。该文所称 conflict 主要是受影响 package 的关联，且进入其验证过程前已有 Git 文本冲突的改动会被拒绝。不能直接把这种绕过规则套到我们的未提交 WIP 或已产生文本冲突的任务上。

### S07：Cassandra——把潜在冲突编码为任务安排约束

- 文献：Bakhtiar Khan Kasi、Anita Sarma，Cassandra: Proactive Conflict Minimization through Optimized Task Scheduling，ICSE 2013，[作者机构页面](https://digitalcommons.unl.edu/cseconfwork/275/)、[作者论文](https://web.engr.oregonstate.edu/~sarmaa/wp-content/uploads/2020/08/2486788.2486884.pdf)。
- 方法：依据任务、文件依赖及开发者偏好建立约束，推荐较少冲突的开发路径；评价覆盖四个开源项目及模拟场景。
- 对本任务的价值：依赖约束与优化目标应分开；任务共享文件不自动等于必须按某方向执行。
- 迁移限制：它主要安排尚未完成的开发任务。我们重新排列的是已经完成的改动，不能倒推已消除其开发阶段的不兼容。
- 补充：[作者关于 scheduler 评价的方法论文](https://epiclab.github.io/publications/user13-kasi.pdf)提醒，忽略已有功能依赖的事后重排会制造不同冲突，模拟场景也不能代表所有现实冲突。
- 阅读状态：已核对原始摘要、论文可检索片段和补充评价讨论；未宣称完成全部正文精读。

### S08：便宜的 Git 特征适合预筛，不证明语义安全

- 文献：Moein Owhadi-Kareshk、Sarah Nadi、Julia Rubin，Predicting Merge Conflicts in Collaborative Software Development，ESEM 2019，[开放论文](https://arxiv.org/pdf/1907.06274)。
- 数据：267,657 个 merge scenario，744 个仓库，七种语言；目标是 Git 文本冲突。
- 方法与结果：九组轻量 Git 特征；无冲突类别的 F1 为 0.95–0.97，冲突类别为 0.57–0.68。需区分类别不平衡下的不同表现。
- 对本任务的价值：预测器可以帮助分配分析预算；“预测无文本冲突”不能解除行为验收，也不能直接迁移成跨任务意图兼容的判断。
- 阅读状态：已阅读开放论文的任务定义、方法及结果相关内容。

### S09：SAM——将测试作为部分规格，比较四个程序版本

- 文献：Léuson Da Silva 等，Detecting Semantic Conflicts with Unit Tests，JSS 214，112070，2024，[出版社 DOI](https://doi.org/10.1016/j.jss.2024.112070)、[本轮阅读的 2023 年开放版本](https://arxiv.org/html/2310.02395v1)。
- 方法：在 Base、Left、Right、Merge 上执行生成测试，用行为差异定位不希望出现的干扰；研究对象主要是 Java。
- 限制：测试是部分规格，作者明确报告漏检；开放 v1 中一个最佳组合检测出 28 个冲突中的 9 个。此数字绑定 v1，未把它冒称为所有后续版本的最终结果。
- 对本任务的价值：冻结统一测试并保留版本矩阵；工具无报警不足以证明不存在意图冲突。
- 阅读状态：已阅读开放版检测流程、评价和限制相关部分。

### S10：SafeMerge——语义无冲突的形式化判据

- 文献：Marcelo Sousa、Isil Dillig、Shuvendu Lahiri，Verified Three-Way Program Merge，OOPSLA 2018，[作者论文](https://www.cs.utexas.edu/~isil/verified-merge.pdf)；相关[早期 arXiv 版本](https://arxiv.org/abs/1802.06551)。
- 方法：结合依赖分析与关系推理，验证合并结果对分支行为的保留。
- 对本任务的价值：提示“正确合并”应表达行为保留义务。它不是可直接接入我们全部 TypeScript、UI、持久化及外部进程行为的现成通用验证器。
- 阅读状态：核对原始摘要和核心方法介绍，未复现工具或完成适用语言能力审计。

### S11：STALE——同一测试集下，独立通过、组合失败

- 文献：Haocheng Xia、Eugene Wu、Yongjoo Park，Passes Alone, Fails Together: Benchmarking Semantic Coordination in Parallel LLM-Agent Development，EXPRESS 2026，[开放全文](https://arxiv.org/html/2609.25396v1)。
- 方法：对相同固定补丁使用同一组合测试集，分别测单独版本与组合版本，只把组合后新增失败计为 interference；另比较获得另一方完整改动信息的条件。
- 结果边界：417 对真实 Django PR 的 834 次运行只出现一次干扰；专门构造的任务中报告 97% 的干扰。作者明确不把构造样本发生率当成真实频率。
- 对本任务的价值：统一判定条件、校验共同起点、区分已有失败与组合新增失败。新增失败的测试数量不等于独立缺陷数量；该判据也不覆盖所有需求冲突。
- 阅读状态：已阅读方法、样本过滤、结果与限制相关部分。

### S12：NP-Bench——主动规划的收益含有多个干预因素

- 文献：Sumanyu Muku，Verifying Coordination in Parallel Coding Agents: NP-Bench and a Scheduling Planner，2026-10-05 arXiv 预印本，[开放全文](https://arxiv.org/html/2610.07261v1)。
- 方法：比较不协调、被动检测、主动规划，以声明的作用域和 producer→consumer 依赖安排工作，验证真实 merge 后的结果。
- 证据边界：包含九个确定性场景和少量 live agent 场景；范围声明已知，部分主要比较同时改变时机、契约信息具体程度和工作分配。
- 对本任务的价值：作为完整整合方法的设计参考。不能把组合干预的全部收益归因于排序，也不能把少量手工场景当成普遍收益证明。
- 阅读状态：已阅读方法、live 比较与 threats to validity 相关部分；未复现实验。

### S13：Zuul——乐观执行未来前缀，失败后重测

- 来源：[Zuul 官方 Project Gating 文档](https://zuul-ci.org/docs/zuul/latest/gating.html)。
- 方法：并行测试 A、A+B、A+B+C 等可能的未来状态；若前项失败，移除它并重测依赖该假设的后项，利用窗口控制推测开销。
- 对本任务的价值：明确区分分支独立验证与实际落地上下文验证，记录被丢弃的验证成本。
- 边界：它提供调度实践，并不证明 FIFO、某个重排器或某套测试可以完整发现语义冲突。
- 阅读状态：已阅读官方行为说明；未安装或运行 Zuul。

### 补充线索：STORM 与 Merge-Bench

- [Multi-agent Collaboration with State Management，2026](https://arxiv.org/html/2605.20563v1)：在写入时核验工作文件及已读依赖是否过期，研究协作过程的状态一致性。阅读了摘要和方法相关部分；当前固定已完成任务的排序实验不实现此协作架构。
- [Merge-Bench，ICPR 2026，作者页面](https://homes.cs.washington.edu/~mernst/pubs/merge-bench-icpr2026-abstract.html)：收集 7,938 个真实冲突 hunk，来自 1,439 个仓库，以开发者提交的 resolution 为参考。它研究文本冲突解析，不是我们跨任务意图冲突的完整真值来源；匹配历史文本与满足需求应分开评价。本轮核对作者摘要及论文片段，未运行模型或数据集。

## 5. 对实验设计的推论

以下是结合文献与本任务条件形成的 Agent 建议，不是文献已经替我们证明的结论。

### 5.1 排序可能降低返工，但不能消除所有固有不兼容

对固定的一批已完成改动，调序的可能收益来自减少重复修复、验证、无效推测及上下文重建。若单步成本固定、串行执行且没有交互，简单换序不会降低处理时间之和。应先查明实际节省发生在哪个环节。

### 5.2 固定质量条件，分别测量速度、成本和发现质量

不能通过把困难任务放到实验窗口外或降低验收标准获得提速。排序器自身的分析、分身启动、修复及重验均进入成本。失败或预算耗尽的组保留未完成状态，不能与完整成功组只比较较短耗时。

### 5.3 将冲突集合视为已验证观测，而非完整真值

按涉及任务集合、违反的需求／契约、触发条件和根因归并。保留首次怀疑、验证和修复的时间，以及文本冲突、行为干扰、需求互斥、已有缺陷和修复新增缺陷的区别。

不同尝试发现的问题可以形成合集，但必须复现和去重。合集仍可能漏掉所有尝试共同未发现的问题，因此不能直接计算完整 recall。后续可用独立审计或已知交互场景补充评价，不能覆盖原始失败历史。

### 5.4 先做同策略约束下的排序对照

本轮三种策略共用明确依赖、原始候选、原会话分身、验证清单和修复预算。完整方法可能改变验证、修复或动态调度，应单独研究；不能混入当前排序因果结论。

### 5.5 指标应覆盖成本后移和负面结果

| 维度 | 建议记录 |
| --- | --- |
| 速度 | 整批通过统一验收的总耗时、各阶段耗时、单任务等待；未完成组单列 |
| Agent 成本 | 新增输入、缓存输入、输出、重试与压缩；价格可核对时再换算费用 |
| 机器成本 | 测试／构建次数、CPU 时间、被废弃工作、安装与环境准备 |
| 质量 | 全部任务需求保留、残留问题及严重程度、失败组与完成比例 |
| 发现质量 | 经复现并按根因去重的问题数、误报、首次发现／确认时间、定位成本 |
| 返工与公平性 | 重复修改、重复验证、复杂任务等待及饥饿情况 |
| 可恢复性 | 中断后能否对账续接、不重复 fork／提交／计费，证据是否持久 |

不预先把多维结果压成随意加权的单一分数。先检查质量门槛，再报告速度和 Token 的取舍；单批任务的重复执行不等于多个独立批次。

## 6. 本地只读调查：历史观测，不是冻结样本

以下调查主要发生在 2026-11-01 02:14 UTC 附近，后续补读了报告和原生使用记录。任务持续变化，恢复实施前必须重新核验。

- task list 经 http://127.0.0.1:3484 超时；本轮转读持久 board.json、sessions.json，再用精确交付报告和原生转录补证。持久摘要没有实时性保证。
- 使用创建／更新时间初筛时得到 19 张近期 Review / In Progress 卡。这只是宽筛，包含元数据更新、已落地任务、父子重复及评审未完成，不能称为 19 个合格样本。
- 查询的旧 RVF 自动收尾记录中未匹配到这些候选，不能据此判定未进行 RVF。新式 task-snapshot review 原件及精确候选报告是另一证据来源。
- 已提交历史在 canonical checkout 的共享对象库只读核对；读取 sibling WIP 使用 GIT_OPTIONAL_LOCKS=0 和 --no-optional-locks。

| 任务 | 当时观测 | 对样本的含义 |
| --- | --- | --- |
| bd273 | 46 个改动路径；报告记录三路评审、最终验证与 ready_to_commit；验证树 7d407a7c06fb9c5d7c3abc8326afbe7560f1ea91 | 预实验优先核验候选，须重验当前字节与模式 |
| 42534 | 14 个改动路径；增量修正后有三路补审及 ready_to_commit；验证树 f130caba668ab8731f42be78980cdc17cd186d46 | 预实验优先核验候选，须核对最终 run 而非较早候选 |
| dd679 | 20 个改动路径；最终说明记录三路评审、6 项发现闭合及当前树一致 | 预实验优先核验候选，后续对话未自动等于代码变化 |
| 11d06 | 74 个改动路径；当时已启动精确 RVF，尚未完成 | 等待原 run 及当前候选补齐，不自行重启评审 |
| 63ecd | 91 个改动路径；当时修复仍在运行 | 待就绪后重新核验和采集 |
| 82e07 | 36 个改动路径；会话明确说明原 RVF 取消、正式状态未完成 | 主 Agent 测试通过不能替换其真实评审状态 |
| 4e935 | 9 个改动路径；交付测试通过，但独立评审覆盖 unknown | 不能仅按 Review 列纳入 |
| 9507b / 2c007 / 53335 | 子任务分别交付状态锁及验证执行修复，父任务 53335 已集成并有整体独立终审说明 | 必须核对整包与子包的覆盖关系，避免重复整合；子任务状态不自动改写为 RVF 完成 |

候选原件路径及定位方式保存于本任务的持久交接说明，供恢复后逐项核验。本文只作调查记录，不替候选任务签发提交或同步资格。

### 已发现的工程复用点与限制

- [git-working-state-snapshot.ts](../../src/independent-task-creation/git-working-state-snapshot.ts) 已实现对象、index 和工作文件归档及前后校验；其恢复函数要求目标使用同一 Git common-dir。不能直接用于完全独立实验仓，更不能为实验放宽生产恢复身份校验。
- [native-conversation-seed.ts](../../src/independent-task-creation/native-conversation-seed.ts) 与 [codex-native-conversation-history.ts](../../src/codex-native-session-protocol/codex-native-conversation-history.ts) 提供原生 fork、边界及历史继承核验参考；现有生产入口不能直接拿来给实验创建生产种子或改写真实归属。
- [原生 fork 计量脚本](../../scripts/measure-codex-fork-cache-repair-candidates.mjs) 有私有配置、父子身份、回合绑定计量及创建结果未知时先对账的参考实现。
- 本轮只读确认 Codex CLI 为 0.166.0，帮助页提供 exec fork。未实际 fork 或发起模型回合。
- bd273、42534 的最近一次原生请求 input_tokens 约为 419,595、419,032；dd679 约为 86,614。这是历史请求读数，不是恢复后上下文的保证，也不是新实验已消耗的 Token。不能假设分身首轮缓存必定命中。
- 当时 Docker CLI 存在但 daemon 不可达；没有启动 Docker。隔离实现仍须验证，不能声称已经具备容器边界。

## 7. 已讨论后移出本轮的 VCS 分支

此前核对过 [DeltaDB 介绍](https://zed.dev/blog/introducing-deltadb)、[Delta 公开 Beta](https://zed.dev/blog/delta-public-beta)、[Scion 官方文章](https://www.anthropic.com/research/redesigning-source-control)，以及 Jujutsu 的[冲突表示](https://docs.jj-vcs.dev/latest/conflicts/)与[操作日志](https://docs.jj-vcs.dev/latest/operation-log/)。

这些资料分别涉及提交间的操作与上下文记录、仓库服务架构、冲突状态和恢复模型。用户已决定当前不深入考虑 Scion / DeltaDB，也不为测试迁移 Jujutsu。它们不是本轮备选实现、依赖或验收要求，不能在恢复时重新扩入范围。

## 8. 当前结论与未完成事项

已有可借鉴的综述、工业调度实践及语义冲突评价方法，足以支持设计小规模、可归因的排序实验。尚未证明任何排序方法在本项目更快、更省 Token 或发现更多冲突。

下一阶段需要实施的工作见实验设计。尚未完成的事项包括：候选重新准入、持久备份、独立恢复、隔离与 fork 核验、排序器、计量器、预实验、正式预算及完整整合方法实验。当前没有实验结果，禁止把本文中的历史测试或别人的工业收益记成本任务的实验通过。
