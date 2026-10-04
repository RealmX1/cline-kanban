// 把维护作业标注的 `finding_candidate` 转投进 findings 的建议通道（B.2）。
//
// 核心包不存 findings——它只在 turn 上挂一个 `finding_candidate` 事件标注，说「这一轮里像是有个值得
// 留下的结论」。真正的 finding 资产在本仓库的 `exploratory-findings-store`（M2 已落地），状态机是
// 「pending 建议 → 用户确认才成为资产」。本模块就是这两者之间的那一跳。
//
// **去重靠 `clientProposalId` 的确定性派生，不另存 relay 账本**：作业每次跑完都会把整份 collection
// 重新读出来，里面的旧标注还在。若每次都新建一条 pending 建议，用户的待确认列表会被同一条结论刷屏。
// ingest 通道本身对同 `clientProposalId` 是幂等 ack（不重复落地），所以只要这个 id 由
// 「会话 + 轮次 + 标注种类」确定性派生，重复转投就天然无害——这比自己维护一张「哪些标注已转投过」的
// 表可靠得多（那张表一旦与 collection 不同步，要么漏投要么重复投）。
//
// 另一个必须显式处理的点：**两个 id 空间**。核心包全程只认原生 session id，而 findings 的 provenance
// 链接要的是宿主 taskId。桥接表由 `assembleExplorationThreadGraphSessionRefs` 一并给出；查不到的标注
// 直接跳过，绝不用原生 id 冒充 taskId（那会落出一条永远解析不了的 provenance 链接）。

import type {
	CompletedTurnSequenceSnapshot,
	ExplorationThreadGraphCollection,
} from "agent-conversation-exploration-thread-graph/core";
import type { RuntimeIngestExploratoryFindingCandidateRequest } from "../core/api-contract";

// findings 契约的硬上限（见 api-contract 的 ingest schema）。超长在这里截断，不让 ingest 因为
// 一条过长的标注整条失败。
const FINDING_TITLE_MAX_LENGTH = 120;
const FINDING_BODY_MAX_LENGTH = 4000;

function truncate(text: string, maxLength: number): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

/**
 * 确定性派生的 dedup 键。同一条标注在任何一次作业之后重新扫到，都会得到同一个 id，
 * 于是 ingest 侧幂等 ack、不重复落地。
 */
export function buildExplorationThreadGraphFindingCandidateProposalId(input: {
	explorationId: string;
	conversationSessionId: string;
	turnNumber: number;
}): string {
	return `exploration-thread-graph:${input.explorationId}:${input.conversationSessionId}:${input.turnNumber}`;
}

/**
 * 从一份 collection 里摘出所有 `finding_candidate` 标注，翻译成 findings 的建议通道请求。
 *
 * 返回空数组是常态——大多数轮次没有标注。
 */
export function collectExplorationThreadGraphFindingCandidateRequests(input: {
	explorationId: string;
	collection: ExplorationThreadGraphCollection;
	turnSnapshotsBySession: ReadonlyMap<string, CompletedTurnSequenceSnapshot>;
	hostTaskIdByNativeSessionId: Readonly<Record<string, string>>;
}): RuntimeIngestExploratoryFindingCandidateRequest[] {
	const requests: RuntimeIngestExploratoryFindingCandidateRequest[] = [];
	for (const eventMark of input.collection.turnEventMarks) {
		if (eventMark.mark !== "finding_candidate") {
			continue;
		}
		// 用户手工加的标注不转投：它已经是用户自己的动作，再生成一条「待用户确认的建议」是循环。
		if (eventMark.generationSource !== "work_branch_maintenance_job") {
			continue;
		}
		const conversationSessionId = eventMark.turnRef.conversationSessionId;
		const hostTaskId = input.hostTaskIdByNativeSessionId[conversationSessionId];
		if (hostTaskId === undefined) {
			// 这条标注所属的会话已经不在本次的会话清单里（被剔除或已删）——没有可用的 taskId，
			// 与其伪造一条解析不了的 provenance 链接，不如跳过。
			continue;
		}

		const turn = input.turnSnapshotsBySession
			.get(conversationSessionId)
			?.turns.find((candidate) => candidate.turnNumber === eventMark.turnRef.turnNumber);

		// 标题优先用标注自带的 note（那是分身对「这里有什么结论」的判断）；没有 note 时回落到该轮的
		// 用户提问摘录——总比一个只有编号的空标题有用。
		const titleSource = eventMark.note ?? turn?.userPromptExcerpt ?? "";
		const findingTitle = truncate(
			titleSource.trim().length > 0
				? titleSource.trim()
				: `探索线标注的候选结论（第 ${eventMark.turnRef.turnNumber} 轮）`,
			FINDING_TITLE_MAX_LENGTH,
		);

		// 正文把标注与该轮的上下文摘录并排放：用户确认时要看得到「凭什么说这里有结论」。
		const bodyParts: string[] = [];
		if (eventMark.note !== null && eventMark.note.trim().length > 0) {
			bodyParts.push(eventMark.note.trim());
		}
		if (turn !== undefined) {
			bodyParts.push(`**第 ${turn.turnNumber} 轮提问**\n\n${turn.userPromptExcerpt}`);
			bodyParts.push(`**回答摘录**\n\n${turn.assistantResponseExcerpt}`);
		}
		const findingBodyMarkdown = truncate(
			bodyParts.length > 0 ? bodyParts.join("\n\n") : findingTitle,
			FINDING_BODY_MAX_LENGTH,
		);

		requests.push({
			conversationSessionTaskId: hostTaskId,
			clientProposalId: buildExplorationThreadGraphFindingCandidateProposalId({
				explorationId: input.explorationId,
				conversationSessionId,
				turnNumber: eventMark.turnRef.turnNumber,
			}),
			findingTitle,
			findingBodyMarkdown,
			provenanceLinks: [
				{
					linkKind: "turn_anchor",
					conversationSessionTaskId: hostTaskId,
					turnNumber: eventMark.turnRef.turnNumber,
					// checkpoint 是锦上添花：核心包解析不到时就是 null（仅时间锚），ingest 侧允许。
					turnCheckpointCommit: eventMark.turnRef.turnCheckpointCommit,
				},
			],
		});
	}
	return requests;
}
