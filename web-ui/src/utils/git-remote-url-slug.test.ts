import { describe, expect, it } from "vitest";
import { extractGitHubOwnerRepoSlug } from "./git-remote-url-slug";

describe("extractGitHubOwnerRepoSlug", () => {
	it("normalizes every common GitHub remote URL shape to a lowercase owner/repo slug", () => {
		const forms = [
			"https://github.com/RealmX1/cline-kanban.git",
			"https://github.com/RealmX1/cline-kanban",
			"https://github.com/RealmX1/cline-kanban/",
			"git@github.com:RealmX1/cline-kanban.git",
			"git@github.com:RealmX1/cline-kanban",
			"ssh://git@github.com/RealmX1/cline-kanban.git",
		];
		for (const form of forms) {
			expect(extractGitHubOwnerRepoSlug(form)).toBe("realmx1/cline-kanban");
		}
	});

	it("returns null for empty, non-GitHub, or unparseable URLs", () => {
		expect(extractGitHubOwnerRepoSlug(null)).toBeNull();
		expect(extractGitHubOwnerRepoSlug(undefined)).toBeNull();
		expect(extractGitHubOwnerRepoSlug("")).toBeNull();
		expect(extractGitHubOwnerRepoSlug("https://gitlab.com/RealmX1/cline-kanban.git")).toBeNull();
		expect(extractGitHubOwnerRepoSlug("https://github.com/RealmX1")).toBeNull();
	});
});
