# 命令与内联脚本的目标级离线分析

这个开发工具复用首轮分析器，减少调查时反复撰写长 Python 脚本的负担。它读取显式清单中的已完成命令记录，输出固定输入、目标族候选、完整成本的已知/未知部分及受控语义对照。它不增加 Kanban 运行时依赖，不执行转录中的命令。

需要 Python 3.11 或以上及标准库；根 npm 项目仍要求 Node 22 或以上。Linux/macOS 接入现有 guarded 测试和 CI。受控配方分别声明对 POSIX shell、jq、tail、mktemp、mv、rm 的依赖；缺工具时仅暂停依赖该工具的配方，其余继续执行。每个配方独立记录状态，未验证的等价性为 null；不安装工具、不冒充通过。

## 单一入口

在仓库根目录运行：

```sh
npm run analyze:agent-command-and-inline-script-usage -- \
  --input-manifest ./agent-command-usage-input-manifest.json \
  --analysis-artifacts-directory "$HOME/.cline/kanban/agent-command-usage-analysis-artifacts"
```

先试用合成清单时，将 `--input-manifest` 改为 `test/fixtures/agent-command-usage-analysis/synthetic-analysis-input-manifest.json`。示例只有两条合成执行，抽样不足会如实显示，不能把它当成历史使用调查。

### 按功能查找脚本

源码统一位于 `scripts/agent-command-and-inline-script-usage-analysis/`。入口用动作与产物命名，内部模块按处理职责分目录：

| 相对路径 | 功能 |
| --- | --- |
| `analyze_declared_execution_records_and_generate_usage_report.py` | 读取声明的执行记录，批量运行分析并生成使用报告与回执。 |
| `execution_record_parsing/extract_cli_routes_and_inline_script_bodies.py` | 静态解析shell命令，提取CLI路由、内联正文与AST分类。 |
| `candidate_goal_usage_reporting/classify_candidate_goals_and_render_privacy_safe_usage_report.py` | 分类候选目标、汇总交互负担，生成仅含公开聚合的摘要与HTML。 |
| `synthetic_recipe_validation/compare_fixed_recipe_results_and_preparation_costs.py` | 在隔离合成场景中对比固定配方的结果、失败语义与准备成本。 |
| `reviewed_execution_result_correlation/correlate_native_executions_with_reviewed_analysis_materials.py` | 校验原生执行与已审阅回执、清单和对照材料的关联。 |

回归脚本为 `test/fixtures/agent-command-usage-analysis/verify_declared_execution_record_analysis_and_reporting.py`，继续通过原guarded测试入口执行。原来平铺的Python路径已移动，直接调用源码的使用方需更新路径；上面的npm命令、输入schema及产物文件名保持兼容。分析器指纹递归覆盖子目录源码，并以相对路径区分模块；改名会生成新的版本观察，已有冻结证据仍可按原完整性校验恢复。

成功回执给出 `observationId`、`observationDirectory` 和 `reusedCompletedObservation`。缓存指纹绑定清单目录、解析后的来源路径、文件清单与规范记录，以及分析器与受控工具环境；相同字节在不同路径下不会复用路径过滤结果。复用表示重读既有观察，不是产生新使用事实。

### 批量执行与精炼返回

`--input-manifest` 可以重复，原本分别调用的分析可在同一进程中执行。每份清单独立保留观察、状态与错误，一份坏输入不阻断其他独立清单。批量回执的 `analyses` 按输入顺序返回，`distinctAnalysisObservationCount` 不重复计算同一分析观察，也不作为独立业务目标证据；批处理按顺序执行，不隐含并行或新的业务目标身份。

单份回执保留原有字段，增加 `agentSummary` 与相对 `observationDirectory` 的 `detailFiles`。分析流水线自动生成摘要，Agent可直接读取可计执行数、已观察命令/返回字符、来源或材料异常、未完成配方和结果审阅状态；不必另外手写读取聚合报告的脚本。错误回执提供清单、原因码，坏JSON包含行列；内部错误给异常类型与相关代码位置，不倾倒输入或原始输出。

需要调查时再读详情。`status=completed`仍只表示声明分析完成，配方待验证或CLI退出0但对照未完成会单独列出；精炼不隐藏这些异常。批量全成功返回0，有有效观察但存在失败/部分结果返回3，全失败时参数/材料错误返回2、内部错误返回1。单份错误继续写stderr，批量逐项结果统一写stdout。

`agentInteractionBurden`并列记录已知工具执行数、command字符和记录中可见的工具返回字符。空返回为已观察的0，缺返回为unknown；冲突身份不计入独立统计。工具执行不等于Agent轮次，返回可能只是原生记录的可见部分，不能冒充完整模型输入。模型输入/输出token、费用、能力变化仍未自动采集。

改进方式由模型选择；可引用仓内通用[元Skill](../.codex/skills/agent-workflow-cost-and-context-effectiveness-improvement/SKILL.md)及按需记录模板。当前多清单批处理和摘要生成已接入分析器，不自动扫描所有任务或向其他会话注入报告。

## 输入清单

清单使用 `agent-command-usage-analysis-input/v1`。路径相对清单文件解析，不相对调用者 cwd。窗口含起点、不含终点，必须带时区。

```json
{
  "schemaVersion": "agent-command-usage-analysis-input/v1",
  "analysisWindow": {
    "startInclusive": "2026-10-28T12:30:00Z",
    "endExclusive": "2026-11-04T12:30:00Z"
  },
  "sourceInputs": [
    {
      "path": "./completed-command-records.jsonl",
      "format": "codex-command-execution-jsonl",
      "coverage": "completed-shell-executions"
    }
  ],
  "excludedExecutionSelectors": [],
  "goalSampleSelection": {
    "maximumRecordCount": 60,
    "maximumRecordsPerStructureCluster": 5,
    "minimumStructureClusterCount": 10
  }
}
```

`sourceInputs` 支持两种格式：

- `codex-command-execution-jsonl`：只读取 `event_msg → item_completed → CommandExecution`；显式目录递归展开为 `.jsonl` 文件清单，不读越出目录的符号链接。不支持压缩转录或其他 harness。
- `phase-one-normalized-executions-json`：首轮冻结记录的 JSON 数组；每条包含 `executionId`（可缺失但归属未知）、`at`、`cwd`、`command`、`exitCode`，可带 `output` 和先前 `source` 定位。先前定位只保留为材料，不被用来读取其他文件或推导身份。

覆盖枚举为 `completed-shell-executions`、`direct-cli-subset`、`inline-script-subset`。它们是声明来源的适用范围；前两份子集的并集不代表全部 shell 调用。来源缺失、坏记录或身份冲突存在时，全量分母保持未知。

每个来源可指定 `sha256` 与 `required`（默认 true）。文件摘要对应完整字节；目录摘要对应按路径排序的 `{path, sha256}` 相对文件清单的规范 JSON。首次未填写摘要时，工具会生成带绝对来源路径与摘要的 `private-frozen-analysis-input-manifest.json`，后续直接复用这份清单，不必另写准备脚本。

排除条件可使用 `executionId`、`workingDirectoryPathContains`、`sourcePathContains`。同一条件内取交集，多个条件取并集；路径匹配只用于过滤，不证明任务或会话身份。

可选 `baselineReference` 使用固定的 `algorithmVersion: "phase-one-prototype/v1"`，其 `cliSummary`、`inlineScriptSummary` 分别包含 `path` 和必需的 `sha256`。只导出已校验的数值，历史窗口和新版覆盖/解析差异进入 `baselineMetricBridge`；历史 982/9542 等数字不被新口径覆盖。

`priorInlineClassificationBridge` 另外统计旧标签中保留的原生内联、脚本文件的标准输入，以及代码样式的代理参数等差异。脚本文件可能自行解释或转交参数；在当前声明来源无法证明时保持待证，不把所有未识别项说成旧误报。`commandComposition` 保留观察到的启动前缀、任务/项目身份和业务正文长度；是否属于固定可删样板另行判断。

## 可选：关联已审阅的真实调用结果

主清单可附 `executionResultReviews: {path, sha256}`，路径相对主清单、摘要必填。审阅文件版本为 `agent-command-execution-result-reviews/v1`，上下文固定为 `development_validation`。这是当前任务开发验证工作流的显式审阅，不是自动推断业务目标或生产遥测。

审阅文件包含 `materialTextsBySha256` 和 `reviews`。前者保存最多180份UTF-8原始结果文本，以其真实摘要为键；后者最多60条，每条声明执行ID、command摘要、分析回执/manifest/对照结果各自的材料摘要。工具只读取显式审阅文件及其中的文本，绝不跟随回执中的路径、执行其中的命令或导出整份私有对象。原件整理是一次性审阅准备，成本不能隐藏或算作已节省。

只有执行在声明来源中唯一、command摘要相同，回执观察ID与manifest一致，分析器版本为有效摘要，且manifest确实绑定对照结果字节时才计关联。材料完整性不构成签名认证或用户授权。重复副本只计一次；同执行或同观察发生冲突时保留待证，独立命令分析继续。

`executionResultFeedback` 分开输出有效调用数、独立观察数、分析器版本数、各版本内的业务状态，以及“CLI退出0但对照未完成”的次数。正确拒绝反例仍表示对照执行完成；复用同一观察不增加独立结果证据。`operationGoalObservationId`、首次成功率、修正次数和生产收益继续按原有未知语义保留。

审阅文件缺失或摘要漂移时，先核对既有完整产物中的冻结材料；摘要一致才恢复，主来源失败另记。重放指纹不纳入恢复来源观察ID，避免同一份证据反复生成新观察。坏文件或关联缺证返回部分状态与退出码3，不阻断独立命令统计；相同材料再次调用复用原结果。

## 产物与隐私

每个观察保存在独立的 `observation-<内容指纹>/` 中。目录仅当前用户可访问，文件权限为 600；完成清单最后随整目录原子发布，校验全部产物摘要后才接受缓存。

缓存复用和冻结来源恢复共用归属及全部产物摘要核验；通过后将观察目录权限恢复为 700、文件恢复为 600，再接受既有材料。

| 产物 | 内容与用途 |
| --- | --- |
| `aggregate-usage-summary.json` | 固定类别、数值分布、覆盖、未知成本、历史桥接和最多5个第三阶段候选。 |
| `agent-readable-analysis-summary.json` | 与命令回执相同的精炼观察与异常，加入完整产物摘要核验；旧冻结来源不因缺少新摘要而失去原有恢复资格。 |
| `agent-command-usage-analysis.html` | 离线可读的分布、筛选、完整成本与受控前后对照，不请求网络资源。 |
| `goal-recipe-comparison-results.json` | 本工具固定合成配方的结果、失败、副作用和字符成本；不是实际生产收益。 |
| `private-frozen-analysis-input-manifest.json` | 可重用的输入路径、窗口与材料摘要。 |
| `private-frozen-source-*.json` | 按来源冻结的规范记录、具体文件清单、坏记录计数和恢复证据。 |
| `private-normalized-executions.json` | 去重、冲突、解析与逐执行成本；未知目标身份和准备成本不填0。 |
| `private-goal-evidence-catalog.json` | 确定抽样的来源、结构簇、候选目标、支持线索与反例。 |
| `private-analysis-run-manifest.json` | 分析器和输入摘要、产物绑定、完整/部分状态与恢复条件。 |
| `private-frozen-execution-result-reviews.json` | 仅声明结果审阅时生成；冻结完整审阅文本、摘要和主来源/恢复事实。 |
| `private-reviewed-execution-result-bindings.json` | 仅声明结果审阅时生成；逐条关联、冲突、版本及结果，均留在私有目录。 |

私有材料包含原始命令、定位、ID 或正文，留在仓外持久目录，不加入 Git 或公开 HTML。公开聚合对象按白名单构造，不序列化整个私有记录，错误类别不带原始参数值。合成对照 JSON 中的命令和固定文件名均来自仓内已审配方，不来自真实记录。

发布HTML前先复制到观察目录之外的专用发布目录，再对副本调用 `task visualization publish`。发布入口会就地添加任务署名；直接发布观察中的原件会使其完成清单摘要失效。若已经发生，保留署名副本后用原分析入口恢复原件，再重放确认缓存可复用；不手工改完成清单摘要。附属资源仍须显式映射。

## 目标、成本与受控对照

目标族是待审阅的静态候选；同 AST、同 cwd 或时间相邻都不能证明相同目标。`operationGoalObservationId`、首次成功率、修正次数及完整目标调用数在缺证时保持 null。原生能力候选须另证至少5次相同结果契约、2个可信任务/会话归属，以及现有入口不能满足的缺口。

包装 CLI 的查询候选须观察到具体查询路由；删除、发布及无法确定的路由保留待证。评审文件名须与实际读取语法关联，业务字符串不构成读取证据。抽样先为请求数量的可识别结构簇保留名额，再覆盖目标族和长尾文本；仍受总量及每簇上限约束。

每簇上限 `maximumRecordsPerStructureCluster` 只接受2至5；有至少2条来源记录的簇必须整体保留至少2例，剩余预算不足时跳过并报告预算不足。真实来源单例保留并计入 `singletonClusterCount`，但不计入 `structuralClusterTargetMet` 所要求的至少2例结构簇；因此样本总量可以小于预算上限。

解释器的 `--` 会终止求值选项识别。内联正文依赖变量展开、命令替换或未引用 heredoc 展开时，保留未知正文及 null 字符成本，不执行展开补证；明确引用的字面正文仍可静态提取。

字符按 Unicode 码点计，内联代码已包含于 command，不能重复相加。历史准备文件、工具 payload、token、目标耗时与机会分母不可得时为未知；已知字符小计不冒充完整成本。

工具只执行四组固化的合成配方，均在分析产物目录下隔离 HOME 和工具环境，结束后回收：

- 完整快照：校验查询、JSON和必需字段，失败保护旧文件；直接 `>` 配方作为不等价反例。
- 精确证据：读取已绑定 UTF-8 文本的最后4个 Unicode 码点；`tail -c` 和替换为 latest 作为不等价反例。
- 必需JSON字段：保留null、false、0和空值，拒绝缺字段、坏输入、多文档及错误根类型；不执行输入内容。
- 当前任务完整快照：由原生入口校验会话归属，再核对任务/项目，拒绝symlink和目录，验证600权限、原子替换、写入失败与旧文件保护；内联与任务局部持久脚本分别计费。

直接可复制的命令与适用条件见 [JSON读取及当前任务快照配方](agent-command-json-and-task-snapshot-recipes.md)。新契约不追溯扩大历史观察的覆盖；只查询时仍直接复用原生命令。

合成对照将共享 fixture 的一次性准备与单次配方成本分开。持久脚本的首次成本包含脚本正文，`reusedPreparedInputAuthoredCharacterCount` 只表示已准备后调用成本。无新输入文件的配方成本可明确为0；不能据此把真实任务尚未观察到的准备成本也记成0。受控子进程超时会结束整个进程组并停止余下对照，保留未通过状态。

## 恢复与退出状态

- 原文件消失或摘要漂移时，先找同格式、同覆盖且摘要一致的已校验冻结来源，保留主来源失败原因，不覆盖历史事实。
- 无等价材料时保存部分结果；相同材料指纹复用既有状态，不进行无变化的无限重试。来源或分析器变化后重新核验。
- 中断可整体只读重放；不完整或损坏的本工具产物先保留再重建。没有本工具归属标记的同名目录会拒绝覆盖。
- 不发任务消息、不执行记录中的业务动作，也不新建后台调度器。

| 退出码 | 含义 |
| --- | --- |
| 0 | 声明输入已完成分析，仍可能有记录级未知、抽样不足或配方待验证。 |
| 2 | 参数、清单或输出归属无效。 |
| 3 | 必要来源、历史基线或声明的结果关联缺证，已保存部分结果。 |
| 1 | 内部失败。 |

下游必须同时读取覆盖与对照状态，不能只凭0判断“所有目标已识别”或“优化已经成功”。本工具不新增运行时遥测，不自动提交、部署或实施候选建议；第三阶段与后续进展见 [路线](agent-command-usage-optimization-roadmap.md)。
