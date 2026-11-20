// 卡片未声明推理强度时，续跑沿用已归档 writer 的明确档位。
// 用户把任务选项保存为「沿用 Codex 配置」后，缺省值不再表示继续使用归档档位。
export function resolveResumedCodexReasoningEffortOverride(input: {
	requestedOverride?: string;
	followsNativeConfiguration?: boolean;
	retiredWriterEffort?: string;
}): string | undefined {
	if (input.requestedOverride !== undefined) return input.requestedOverride;
	if (input.followsNativeConfiguration === true) return undefined;
	return input.retiredWriterEffort;
}
