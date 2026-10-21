import { lstat, rm } from "node:fs/promises";
import { z } from "zod";
import { codexNativeSessionControlEndpointSchema } from "../core/codex-native-session-control-endpoint-contract";
import { codexRemoteConversationLaunchPlanSchema } from "./codex-remote-conversation-launch-plan";

export type { CodexNativeSessionControlEndpoint } from "../core/codex-native-session-control-endpoint-contract";

const ownedDirectorySchema = z.object({ path: z.string(), device: z.string(), inode: z.string() });
export type OwnedCodexNativeSessionControlHostDirectory = z.infer<typeof ownedDirectorySchema>;

export const codexNativeSessionControlHostLaunchSpecificationSchema = z.object({
	schemaVersion: z.literal(1),
	endpoint: codexNativeSessionControlEndpointSchema,
	codexBinary: z.string().min(1),
	codexTuiArguments: z.array(z.string()),
	appServerRootArguments: z.array(z.string()),
	// 可选以兼容升级前仍由 PTY host 持有的启动描述与清理接管。
	remoteConversationLaunchPlan: codexRemoteConversationLaunchPlanSchema.optional(),
	workingDirectoryPath: z.string().min(1),
	ownedLaunchDirectory: ownedDirectorySchema,
	ownedSocketDirectory: ownedDirectorySchema,
});

export type CodexNativeSessionControlHostLaunchSpecification = z.infer<
	typeof codexNativeSessionControlHostLaunchSpecificationSchema
>;

export async function removeOwnedCodexNativeSessionControlHostDirectories(
	directories: readonly OwnedCodexNativeSessionControlHostDirectory[],
) {
	for (const directory of directories) {
		try {
			const current = await lstat(directory.path, { bigint: true });
			if (!current.isDirectory() || `${current.dev}` !== directory.device || `${current.ino}` !== directory.inode)
				throw new Error("原生控制宿主清理目标已被替换，保留现场等待核对。");
			await rm(directory.path, { recursive: true, force: true });
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
}
