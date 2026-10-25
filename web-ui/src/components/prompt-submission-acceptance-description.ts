import type { RuntimeAgentConversationPromptSubmissionAcceptance } from "@/runtime/types";

export function describePromptSubmissionAcceptance(
	acceptance: RuntimeAgentConversationPromptSubmissionAcceptance,
): string {
	const source =
		acceptance.submissionSource === "harness_submit_hook"
			? "harness 提交 hook"
			: acceptance.submissionSource === "programmatic_submission"
				? "程序化提交"
				: "旧记录，提交来源未知";
	const reason = acceptance.verification?.reason;
	const reasons = {
		scanning_native_transcript: "正在分段补查原生记录，扫描进度已保存",
		native_evidence_unavailable: "原生记录或控制端点暂不可读，等待恢复后继续核验",
		no_matching_native_message: "尚无可关联的原生接受记录，等待新的证据",
		ambiguous_native_messages: "存在多条可能的接受记录，暂不能确定对应关系",
		native_acceptance_verified: "原生接受记录已核验",
		native_identity_changed: "原生身份发生变化，旧提交不能由其他会话确认",
	};
	return [
		`提交来源：${source}`,
		`提交时间：${new Date(acceptance.attemptedAtMs).toLocaleString()}`,
		reason ? reasons[reason] : "正在核验 harness 是否已接受输入",
		acceptance.verification?.nextCheckAtMs
			? `下次核验：${new Date(acceptance.verification.nextCheckAtMs).toLocaleString()}`
			: "",
		"写入终端或前置 hook 放行不能证明提交成功。",
	]
		.filter(Boolean)
		.join("\n");
}
