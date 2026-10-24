// 调用方必须区分只读预检与已经可能发生写入的阶段，不能仅凭错误原因重发正文。
export type TaskChatDeliveryWriteValidationPhase =
	| "before_transport_acceptance"
	| "before_first_transport_write"
	| "after_transport_write";

export type TaskChatDeliveryWriteValidator = (phase?: TaskChatDeliveryWriteValidationPhase) => Promise<void>;
