import { collectTaskConversationSessionActivityObservations } from "@runtime-agent-conversation-activity-observation";
import type { RuntimeTaskConversationSessionActivityObservation, RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard } from "@/types";

const activityPresentationByCard = new WeakMap<
	BoardCard,
	{ signature: string; observations: RuntimeTaskConversationSessionActivityObservation[] }
>();

/** 同一张卡的有效活动没变时复用列表；其他卡的推流不能让它及所有副本重渲染。 */
export function collectStableTaskConversationSessionActivityPresentationObservations(
	card: BoardCard,
	summaries: Iterable<RuntimeTaskSessionSummary>,
): RuntimeTaskConversationSessionActivityObservation[] {
	const observations = collectTaskConversationSessionActivityObservations(card, summaries);
	const signature = JSON.stringify(observations);
	const previous = activityPresentationByCard.get(card);
	if (previous?.signature === signature) return previous.observations;
	activityPresentationByCard.set(card, { signature, observations });
	return observations;
}
