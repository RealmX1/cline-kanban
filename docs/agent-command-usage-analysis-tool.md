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

成功回执给出 `observationId`、`observationDirectory` 和 `reusedCompletedObservation`。缓存指纹绑定清单目录、解析后的来源路径、文件清单与规范记录，以及分析器与受控工具环境；相同字节在不同路径下不会复用路径过滤结果。复用表示重读既有观察，不是产生新使用事实。

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

## 产物与隐私

每个观察保存在独立的 `observation-<内容指纹>/` 中。目录仅当前用户可访问，文件权限为 600；完成清单最后随整目录原子发布，校验全部产物摘要后才接受缓存。

缓存复用和冻结来源恢复共用归属及全部产物摘要核验；通过后将观察目录权限恢复为 700、文件恢复为 600，再接受既有材料。

| 产物 | 内容与用途 |
| --- | --- |
| `aggregate-usage-summary.json` | 固定类别、数值分布、覆盖、未知成本、历史桥接和最多5个第三阶段候选。 |
| `agent-command-usage-analysis.html` | 离线可读的分布、筛选、完整成本与受控前后对照，不请求网络资源。 |
| `goal-recipe-comparison-results.json` | 本工具固定合成配方的结果、失败、副作用和字符成本；不是实际生产收益。 |
| `private-frozen-analysis-input-manifest.json` | 可重用的输入路径、窗口与材料摘要。 |
| `private-frozen-source-*.json` | 按来源冻结的规范记录、具体文件清单、坏记录计数和恢复证据。 |
| `private-normalized-executions.json` | 去重、冲突、解析与逐执行成本；未知目标身份和准备成本不填0。 |
| `private-goal-evidence-catalog.json` | 确定抽样的来源、结构簇、候选目标、支持线索与反例。 |
| `private-analysis-run-manifest.json` | 分析器和输入摘要、产物绑定、完整/部分状态与恢复条件。 |

私有材料包含原始命令、定位、ID 或正文，留在仓外持久目录，不加入 Git 或公开 HTML。公开聚合对象按白名单构造，不序列化整个私有记录，错误类别不带原始参数值。合成对照 JSON 中的命令和固定文件名均来自仓内已审配方，不来自真实记录。

## 目标、成本与受控对照

目标族是待审阅的静态候选；同 AST、同 cwd 或时间相邻都不能证明相同目标。`operationGoalObservationId`、首次成功率、修正次数及完整目标调用数在缺证时保持 null。原生能力候选须另证至少5次相同结果契约、2个可信任务/会话归属，以及现有入口不能满足的缺口。

包装 CLI 的查询候选须观察到具体查询路由；删除、发布及无法确定的路由保留待证。评审文件名须与实际读取语法关联，业务字符串不构成读取证据。抽样先为请求数量的可识别结构簇保留名额，再覆盖目标族和长尾文本；仍受总量及每簇上限约束。

每簇上限 `maximumRecordsPerStructureCluster` 只接受2至5；有至少2条来源记录的簇必须整体保留至少2例，剩余预算不足时跳过并报告预算不足。真实来源单例保留并计入 `singletonClusterCount`，但不计入 `structuralClusterTargetMet` 所要求的至少2例结构簇；因此样本总量可以小于预算上限。

解释器的 `--` 会终止求值选项识别。内联正文依赖变量展开、命令替换或未引用 heredoc 展开时，保留未知正文及 null 字符成本，不执行展开补证；明确引用的字面正文仍可静态提取。

字符按 Unicode 码点计，内联代码已包含于 command，不能重复相加。历史准备文件、工具 payload、token、目标耗时与机会分母不可得时为未知；已知字符小计不冒充完整成本。

工具只执行两组固化的合成配方，均在分析产物目录下隔离 HOME 和工具环境，结束后回收：

- 完整快照：校验查询、JSON和必需字段，失败保护旧文件；直接 `>` 配方作为不等价反例。
- 精确证据：读取已绑定 UTF-8 文本的最后4个 Unicode 码点；`tail -c` 和替换为 latest 作为不等价反例。

合成对照将共享 fixture 的一次性准备与单次配方成本分开。无新输入文件的配方成本可明确为0；不能据此把真实任务尚未观察到的准备成本也记成0。受控子进程超时会结束整个进程组并停止余下对照，保留未通过状态。

## 恢复与退出状态

- 原文件消失或摘要漂移时，先找同格式、同覆盖且摘要一致的已校验冻结来源，保留主来源失败原因，不覆盖历史事实。
- 无等价材料时保存部分结果；相同材料指纹复用既有状态，不进行无变化的无限重试。来源或分析器变化后重新核验。
- 中断可整体只读重放；不完整或损坏的本工具产物先保留再重建。没有本工具归属标记的同名目录会拒绝覆盖。
- 不发任务消息、不执行记录中的业务动作，也不新建后台调度器。

| 退出码 | 含义 |
| --- | --- |
| 0 | 声明输入已完成分析，仍可能有记录级未知、抽样不足或配方待验证。 |
| 2 | 参数、清单或输出归属无效。 |
| 3 | 必要来源或历史基线缺证，已保存部分结果。 |
| 1 | 内部失败。 |

下游必须同时读取覆盖与对照状态，不能只凭0判断“所有目标已识别”或“优化已经成功”。这一步不新增运行时遥测、不提交、不部署，也不自动开启第三至第五阶段。
