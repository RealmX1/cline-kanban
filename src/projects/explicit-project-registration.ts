import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { RuntimeProjectAddRequest } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import type { KanbanRequestOriginActorEvidence } from "../inter-work-unit-relation-ledger/kanban-actor-resolution-from-request-origin-evidence";
import {
	findConsolidatedRepositoryPath,
	resolveConsolidatedWorkspaceId,
} from "../state/duplicate-project-consolidation-status";
import { resolveGitCommonDirectory } from "../state/registered-workspace-invocation-context";
import { getRuntimeHomePath } from "../state/runtime-home-path";
import { listWorkspaceIndexEntries, resolveWorkspacePath } from "../state/workspace-state";

export async function previewExplicitProjectRegistration(path: string) {
	const repositoryPath = await resolveWorkspacePath(path);
	const gitCommonDirectory = await resolveGitCommonDirectory(repositoryPath);
	const sameRepositoryWorkspaceIds: string[] = [];
	const entries = await listWorkspaceIndexEntries({ requireCompleteRead: true });
	for (const entry of entries) {
		try {
			if ((await resolveGitCommonDirectory(entry.repoPath)) === gitCommonDirectory)
				sameRepositoryWorkspaceIds.push(entry.workspaceId);
		} catch {
			// 其他不可访问项目不会使当前路径的预览产生写入。
		}
	}
	const retired = await findConsolidatedRepositoryPath(repositoryPath);
	if (retired && retired.status !== "completed") throw new Error("来源项目正在合并，请等待原操作完成。");
	const preview = {
		path: repositoryPath,
		gitCommonDirectory,
		registeredWorkspaceId:
			entries.find((entry) => entry.repoPath === repositoryPath)?.workspaceId ??
			(retired ? await resolveConsolidatedWorkspaceId(retired.targetWorkspaceId) : null),
		sameRepositoryWorkspaceIds: sameRepositoryWorkspaceIds.sort(),
	};
	return { ...preview, previewFingerprint: createHash("sha256").update(JSON.stringify(preview)).digest("hex") };
}

/** 原话与来源是防误用凭据；它们不等于经过独立认证的用户身份。 */
export async function authorizeExplicitProjectRegistration(
	input: RuntimeProjectAddRequest,
	evidence: KanbanRequestOriginActorEvidence,
) {
	const fromWebUi =
		evidence.decodedCliActorClaimsRequestHeader.cliActorClaimsRequestHeaderStatus === "absent" &&
		evidence.webUiPageLoadRequestOriginNonceVerificationStatus === "verified";
	if (fromWebUi) return null;
	if (!input.authorization || !input.previewFingerprint || !input.path || input.gitUrl || input.initializeGit)
		throw new Error("非界面调用新增项目必须提供用户授权原话、来源和 project preview-add 返回的路径预览指纹。");
	const preview = await previewExplicitProjectRegistration(input.path);
	if (input.path !== preview.path) throw new Error("新增请求必须使用预览返回的完整规范路径。");
	if (preview.previewFingerprint !== input.previewFingerprint)
		throw new Error("项目路径或注册状态已变化，请重新预览后再新增。");
	const auditPath = join(getRuntimeHomePath(), "explicit-project-registration-audit", `${randomUUID()}.json`);
	const audit = {
		schemaVersion: 1,
		status: "authorized_before_registration",
		authorizedAt: Date.now(),
		preview,
		authorization: input.authorization,
		requestOriginActorEvidence: evidence,
	};
	await lockedFileSystem.writeJsonFileAtomic(auditPath, audit, { durable: true, fileMode: 0o600 });
	return { auditPath, audit };
}
