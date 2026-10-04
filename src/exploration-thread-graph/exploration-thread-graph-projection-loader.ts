// 读出一张可渲染的 exploration thread graph（B.2 宿主胶水）。
//
// 核心包把「图」拆成两半：落盘的 collection（归属、线、边、标注）与**不落盘**的 turn 行内容
// （用户 prompt 与回答摘录，实时从 transcript 投影出来）。只有 collection 摊不出任何一行——
// `buildExplorationThreadGraphProjectionView` 必须同时拿到 turn 快照才能出行。所以「读图」这件事
// 恒等于「读 collection + 读每条会话的 turn 快照 + 合成」，本模块就是这一步，读路径与作业跑完后的
// 广播路径共用它，避免两处各写一遍合成逻辑而漂移。
//
// 降级纪律：单条会话的 transcript 读不出来（文件被删、格式漂移、超预算的畸形单行）**不炸整张图**
// ——那条会话的 turn 行缺席，其余照常渲染。核心包对缺席会话的处理是「没有行」，不是错误。
// 但 collection 与 topic registry 读失败会照常抛：那是图本身的真相，读不出来就不该假装有图。
//
// 「读不出来」怎么表达：核心包的 turn 源适配器**不抛错**，而是回一份 `turns` 为空、`sourceSignature`
// 为 `unavailable` 的哨兵快照（只有 harnessKind 不匹配才抛）。所以识别不可用必须认这个哨兵签名——
// 只靠 try/catch 的话，不可用会伪装成「这条会话一个已完成 turn 都没有」：面板不再警告、节流闸也把它
// 当成 0 个未归位 turn。哨兵快照因此**不进** `turnSnapshotsBySession`，只记进不可用清单。

import type {
	CompletedTurnSequenceSnapshot,
	CompletedTurnSequenceSource,
	ConversationSessionRef,
	ExplorationThreadGraphCollection,
	ExplorationThreadGraphProjectionView,
} from "agent-conversation-exploration-thread-graph/core";
import {
	buildExplorationThreadGraphProjectionView,
	readExplorationThreadGraphCollection,
	readExplorationTopicRegistry,
} from "agent-conversation-exploration-thread-graph/core";

// 核心包适配器用来表达「这条会话的转录这次读不出来」的哨兵 `sourceSignature`（见
// ClaudeCodeTranscriptCompletedTurnSource：文件缺失 / 不可读 / 存在超预算单行时回哨兵快照而不抛）。
// 它是签名取值域里的保留字面值——真实签名恒是 `${mtimeMs}:${size}:${offset}` 这类带冒号的三段式。
export const COMPLETED_TURN_SEQUENCE_UNAVAILABLE_SNAPSHOT_SOURCE_SIGNATURE = "unavailable";

export interface ExplorationThreadGraphProjectionLoadResult {
	view: ExplorationThreadGraphProjectionView;
	// 落盘本体。节流闸要读它的 lastPlacedTurnNumberBySession 与 lastMaintenanceJobCompletedAt——
	// 那两项不在投影整值里（投影是给渲染看的），从投影反推只会得到一份不完整的假 collection。
	collection: ExplorationThreadGraphCollection;
	// 作业与节流判定要复用这批快照（重读一次 transcript 没有意义，且两次读之间文件可能又长了）。
	turnSnapshotsBySession: Map<string, CompletedTurnSequenceSnapshot>;
	// 本次读取中 transcript 不可用的会话原生 id。UI 可据此说明「这条会话的轮次暂时读不到」。
	turnSourceUnavailableSessionIds: string[];
}

/**
 * 读出某个 exploration 的完整投影整值。
 *
 * `sessionRefs` 由 `assembleExplorationThreadGraphSessionRefs` 给出（主会话在 `[0]`）；本函数不做
 * 会话发现，只按给定清单读。空清单也是合法输入——返回一张没有 turn 行的空图，而不是错误：
 * exploratory 卡片刚建、还没有任何会话盖过 sidecar 时就是这个状态。
 */
export async function loadExplorationThreadGraphProjection(input: {
	explorationId: string;
	storeRoot: string;
	sessionRefs: readonly ConversationSessionRef[];
	turnSource: CompletedTurnSequenceSource;
}): Promise<ExplorationThreadGraphProjectionLoadResult> {
	const [collection, topicRegistry] = await Promise.all([
		readExplorationThreadGraphCollection(input.storeRoot, input.explorationId),
		readExplorationTopicRegistry(input.storeRoot),
	]);

	const turnSnapshotsBySession = new Map<string, CompletedTurnSequenceSnapshot>();
	const turnSourceUnavailableSessionIds: string[] = [];
	for (const sessionRef of input.sessionRefs) {
		try {
			const snapshot = await input.turnSource.readCompletedTurnSequence(sessionRef);
			if (snapshot.sourceSignature === COMPLETED_TURN_SEQUENCE_UNAVAILABLE_SNAPSHOT_SOURCE_SIGNATURE) {
				// 适配器显式说了「这次读不出来」：绝不把哨兵快照喂进投影与节流判定——那等于把「读不到」
				// 说成「0 个已完成 turn」。
				turnSourceUnavailableSessionIds.push(sessionRef.nativeSessionId);
				continue;
			}
			turnSnapshotsBySession.set(snapshot.conversationSessionId, snapshot);
		} catch {
			// 兜底：适配器契约未来可能改回抛错，且 harnessKind 不匹配现在就抛。
			// 单条会话的转录不可用：这条没有 turn 行，其余会话与整张图照常。
			turnSourceUnavailableSessionIds.push(sessionRef.nativeSessionId);
		}
	}

	return {
		view: buildExplorationThreadGraphProjectionView(collection, turnSnapshotsBySession, topicRegistry),
		collection,
		turnSnapshotsBySession,
		turnSourceUnavailableSessionIds,
	};
}
