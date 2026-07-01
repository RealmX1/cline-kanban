import { useMemo } from "react";

import { KANBAN_DEV_PROJECT_GITHUB_SLUG } from "@/config/issue-reporting-urls";
import type { RuntimeProjectSummary } from "@/runtime/types";
import { extractGitHubOwnerRepoSlug } from "@/utils/git-remote-url-slug";

/**
 * Detect the cline-kanban developer project among the user's Kanban projects.
 *
 * Developer mode is STRICT: a project qualifies only when its git `remote.origin.url`
 * normalizes to KANBAN_DEV_PROJECT_GITHUB_SLUG (realmx1/cline-kanban). Name/path
 * heuristics are intentionally NOT used. When multiple projects match, the first one
 * (stream order) wins — there is normally exactly one.
 *
 * Returns the matching RuntimeProjectSummary (whose `id` is the workspaceId to scope the
 * add-backlog-task tRPC call, and `path` is the repo path) or null when none matches.
 */
export function useClineKanbanDevProject(projects: RuntimeProjectSummary[]): RuntimeProjectSummary | null {
	return useMemo(() => {
		return (
			projects.find(
				(project) => extractGitHubOwnerRepoSlug(project.gitRemoteOriginUrl) === KANBAN_DEV_PROJECT_GITHUB_SLUG,
			) ?? null
		);
	}, [projects]);
}
