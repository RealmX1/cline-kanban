import { createHash } from "node:crypto";
import type { RuntimeConditionalWorkspaceChangesResponse, RuntimeWorkspaceChangesResponse } from "../core/api-contract";

export function buildConditionalWorkspaceChangesResponse(
	changes: RuntimeWorkspaceChangesResponse,
	knownContentVersion?: string,
): RuntimeConditionalWorkspaceChangesResponse {
	const { generatedAt: _generatedAt, ...content } = changes;
	const contentVersion = createHash("sha256").update(JSON.stringify(content)).digest("hex");
	return contentVersion === knownContentVersion
		? { status: "unchanged", contentVersion }
		: { status: "changed", contentVersion, changes };
}
