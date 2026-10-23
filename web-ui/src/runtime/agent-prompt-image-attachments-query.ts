import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { TaskImage } from "@/types";

export const agentPromptImageAttachmentQueries = {
	save: (images: TaskImage[]) => getRuntimeTrpcClient(null).support.saveAgentPromptImageAttachments.mutate({ images }),
	read: (imageAttachmentIds: string[]) =>
		getRuntimeTrpcClient(null).support.readAgentPromptImageAttachments.query({ imageAttachmentIds }),
};
