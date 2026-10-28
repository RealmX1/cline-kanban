import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveAgentGuidanceDocumentPath(
	filename: "task-authoring-and-startup-settings.md" | "kanban-command-reference.md",
): string {
	const moduleDirectory = dirname(fileURLToPath(import.meta.url));
	const sourceDocument = join(moduleDirectory, "..", "..", "docs", "agent-guidance", filename);
	return existsSync(sourceDocument) ? sourceDocument : join(moduleDirectory, "agent-guidance", filename);
}
