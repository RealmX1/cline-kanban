/**
 * Extract the lowercase GitHub `owner/repo` slug from a git remote URL.
 *
 * Handles the URL shapes `git config --get remote.origin.url` can emit for a GitHub repo:
 *   - https://github.com/RealmX1/cline-kanban.git
 *   - https://github.com/RealmX1/cline-kanban
 *   - git@github.com:RealmX1/cline-kanban.git
 *   - ssh://git@github.com/RealmX1/cline-kanban.git
 * plus trailing slashes and mixed case. Returns `null` for non-GitHub or unparseable URLs.
 *
 * Used to detect the cline-kanban developer project by comparing against
 * KANBAN_DEV_PROJECT_GITHUB_SLUG.
 */
export function extractGitHubOwnerRepoSlug(url: string | null | undefined): string | null {
	if (!url) {
		return null;
	}
	const trimmed = url.trim();
	if (!trimmed) {
		return null;
	}

	// Normalize the "path after the host" for both scp-like and URL forms.
	// scp-like: git@github.com:owner/repo(.git)
	const scpMatch = trimmed.match(/^[^@]+@github\.com:(.+)$/i);
	let pathPart: string | null = null;
	if (scpMatch?.[1]) {
		pathPart = scpMatch[1];
	} else {
		// URL forms: https://github.com/owner/repo(.git), ssh://git@github.com/owner/repo(.git)
		const urlMatch = trimmed.match(/github\.com[/:]([^?#]+)$/i);
		pathPart = urlMatch?.[1] ?? null;
	}
	if (!pathPart) {
		return null;
	}

	const segments = pathPart
		.replace(/\.git$/i, "")
		.replace(/\/+$/g, "")
		.split("/")
		.filter((segment) => segment.length > 0);
	if (segments.length < 2) {
		return null;
	}
	const owner = segments[0];
	const repo = segments[1];
	return `${owner}/${repo}`.toLowerCase();
}
