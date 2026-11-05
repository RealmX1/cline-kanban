import { Hourglass } from "lucide-react";
import {
	describePromptSubmissionAcceptance,
	promptSubmissionAcceptanceLabel,
} from "@/components/prompt-submission-acceptance-description";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

export function TaskPromptSubmissionAcceptanceNotice({
	acceptance,
}: {
	acceptance: RuntimeTaskSessionSummary["agentConversationPromptSubmissionAcceptance"];
}) {
	if (!acceptance || acceptance.status === "accepted") return null;
	return (
		<span
			role="status"
			title={describePromptSubmissionAcceptance(acceptance)}
			className="inline-flex items-center gap-0.5 text-[10px] text-text-secondary"
		>
			<Hourglass size={10} />
			{promptSubmissionAcceptanceLabel(acceptance)}
		</span>
	);
}
