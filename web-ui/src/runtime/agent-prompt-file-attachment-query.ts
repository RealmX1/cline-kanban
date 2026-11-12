import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeSaveAgentPromptFileAttachmentRequest } from "@/runtime/types";

export const agentPromptFileAttachmentQueries = {
	save: (file: RuntimeSaveAgentPromptFileAttachmentRequest) =>
		getRuntimeTrpcClient(null).support.saveAgentPromptFileAttachment.mutate(file),
};
