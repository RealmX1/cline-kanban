import { z } from "zod";

// 只解析旧清单的目录与代际身份，撤除 profile 业务状态。
export const legacyCodexConfigurationWriterBindingSchema = z.object({
	schemaVersion: z.literal(1),
	writerId: z.string().uuid(),
	purpose: z.enum(["native_session", "auxiliary_process"]),
	workspaceId: z.string().nullable(),
	conversationSessionId: z.string().nullable(),
	runtimeSessionIncarnationId: z.string().uuid(),
	configurationHomeDirectoryPath: z.string().min(1),
	conversationStorageHomeDirectoryPath: z.string().min(1),
	sqliteHomeDirectoryPath: z.string().min(1),
	sourceHomeDirectoryPath: z.string().min(1),
	sourceIdentity: z.string().min(1),
	storageDirectoryIdentity: z.string().min(1),
	sqliteDirectoryIdentity: z.string().min(1),
	createdAt: z.number(),
});
