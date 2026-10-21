import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	type ReferenceRelationModelingEditorDraft,
	referenceRelationModelingEditorDraftSchema,
} from "../core/work-unit-relation-modeling-api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath } from "./workspace-state";

const draftsSchema = z.record(z.string(), referenceRelationModelingEditorDraftSchema);
function draftsPath(workspaceId: string) {
	return join(getWorkspaceDirectoryPath(workspaceId), "reference-relation-modeling-editor-drafts.json");
}
async function readDrafts(workspaceId: string) {
	try {
		return draftsSchema.parse(JSON.parse(await readFile(draftsPath(workspaceId), "utf8")));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
		// 草稿不是缓存，损坏或不可读时拒绝覆盖，保留可供恢复的原文件。
		throw error;
	}
}
export async function readReferenceRelationModelingEditorDraft(input: { workspaceId: string; draftScopeId: string }) {
	return (await readDrafts(input.workspaceId))[input.draftScopeId] ?? null;
}
export async function saveReferenceRelationModelingEditorDraft(input: {
	workspaceId: string;
	draftScopeId: string;
	draft: ReferenceRelationModelingEditorDraft | null;
}) {
	const path = draftsPath(input.workspaceId);
	await lockedFileSystem.withLock({ path, type: "file" }, async () => {
		const drafts = await readDrafts(input.workspaceId);
		if (input.draft) drafts[input.draftScopeId] = input.draft;
		else delete drafts[input.draftScopeId];
		await lockedFileSystem.writeJsonFileAtomic(path, drafts, { lock: null });
	});
	return { saved: true };
}
