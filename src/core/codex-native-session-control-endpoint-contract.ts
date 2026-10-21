import { z } from "zod";

// 端点属于一次真实会话启动，不是可跨任务复用的默认 daemon 地址。
export const codexNativeSessionControlEndpointSchema = z.object({
	socketPath: z.string().min(1),
	workspaceId: z.string().min(1),
	conversationSessionId: z.string().min(1),
	runtimeSessionIncarnationId: z.string().uuid(),
});

export type CodexNativeSessionControlEndpoint = z.infer<typeof codexNativeSessionControlEndpointSchema>;
