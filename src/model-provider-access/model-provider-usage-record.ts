// 每次调用外部模型 provider 留下的一条用量记录。
//
// 目的是**事后统计**，不是排障：哪个功能在烧钱、哪家 provider 在超时、某个用途的 token 量级是多少。
// 所以每条记录都必须带一个 `modelUsagePurpose`（用途角色）——它是把「一次 HTTP 调用」翻译成
// 「Kanban 的哪个功能在用它」的唯一钥匙，也正因如此它在请求参数里是**必填**的，没有默认值可退。
//
// 用途刻意不写进环境变量名（凭据按 provider 编址，见 model-provider-credentials-from-environment.ts）：
// 那样同一把 key 要在每个用途下重复配一遍，而且一次功能改名会变成一次环境变量迁移。
//
// 落盘复用既有的轮转 JSONL journal：自带大小上限、保留策略、永不抛错，以及测试隔离的根目录覆写。
// 别再造第二套文件格式。

import { appendDiagnosticEventToRotatingJsonlJournal } from "../diagnostics/rotating-jsonl-diagnostic-event-journal";

/**
 * 「Kanban 的哪个功能在用这次调用」。
 *
 * 用字面量联合而不是任意字符串：用途集合要能被穷举、被 grep、被统计脚本安全地当维度用。
 * 新功能接入时在这里加一个成员——那一步正是「这次调用该记成什么」的强制表态点。
 */
export type ModelUsagePurpose = "task_name_suggestion" | "notification_assessment";

export type ModelProviderCallOutcome = "completed" | "unavailable";

export interface ModelProviderUsageRecord {
	modelUsagePurpose: ModelUsagePurpose;
	/** 没解析出 provider（一家都没配）时为 null——那种失败同样要记，否则「从没配过」看起来像「从没用过」。 */
	modelProviderId: string | null;
	modelId: string | null;
	outcome: ModelProviderCallOutcome;
	/** outcome=unavailable 时才有。 */
	unavailableReason?: string;
	/** 上游 HTTP 状态码，拿得到才有。 */
	httpStatusCode?: number;
	/** 从发起到拿到结果的墙钟耗时；没发出请求（没配 provider）时为 0。 */
	elapsedMs: number;
	/** 送进去的 prompt 字符数——上游不回 token 用量时的粗略替代量纲。 */
	promptCharacterCount: number;
	promptTokenCount?: number;
	completionTokenCount?: number;
	totalTokenCount?: number;
}

/** fire-and-forget：写入排队、失败内部吞掉，绝不影响被记录的那次调用。 */
export function recordModelProviderUsage(usageRecord: ModelProviderUsageRecord): void {
	appendDiagnosticEventToRotatingJsonlJournal("model-provider-usage", { ...usageRecord });
}
