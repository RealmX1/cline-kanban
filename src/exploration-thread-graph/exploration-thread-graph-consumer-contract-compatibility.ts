// web-ui 不能引入含 Node store 的核心包，契约层因此保留浏览器可用的 zod 投影镜像。
// 只检查实际消费方向：核心输出须可赋给宿主契约；宿主未消费的新增字段允许由 zod 剥离。
import type { ExplorationThreadGraphProjectionView } from "agent-conversation-exploration-thread-graph/core";
import type { RuntimeExplorationThreadGraphProjectionView } from "../core/api-contract";

// 元组包裹避免联合分发：任何一个新枚举值不被宿主接收，都应阻断升级。
export type IsExplorationThreadGraphProjectionAcceptedByConsumer<ProducerProjection> = [ProducerProjection] extends [
	RuntimeExplorationThreadGraphProjectionView,
]
	? true
	: false;

type AssertConsumerCompatibility<Compatible extends true> = Compatible;

// 缺少宿主必需字段、字段类型不兼容或枚举扩大时须先升级宿主契约，不能直接放行。
export type ExplorationThreadGraphProjectionViewConsumerCompatibility = AssertConsumerCompatibility<
	IsExplorationThreadGraphProjectionAcceptedByConsumer<ExplorationThreadGraphProjectionView>
>;
