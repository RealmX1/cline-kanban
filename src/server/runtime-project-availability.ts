import { stat } from "node:fs/promises";

import type { RuntimeProjectAvailability } from "../core/api-contract";
import { runGit } from "../workspace/git-utils";

interface RuntimeProjectPathStat {
	isDirectory: () => boolean;
}

export interface RuntimeProjectAvailabilityInspectionDependencies {
	statProjectPath: (projectPath: string) => Promise<RuntimeProjectPathStat>;
	verifyGitWorkTree: (projectPath: string) => Promise<boolean>;
}

const defaultRuntimeProjectAvailabilityInspectionDependencies: RuntimeProjectAvailabilityInspectionDependencies = {
	statProjectPath: stat,
	verifyGitWorkTree: async (projectPath) => {
		const result = await runGit(projectPath, ["rev-parse", "--is-inside-work-tree"]);
		return result.ok && result.stdout.trim() === "true";
	},
};

function isMissingProjectPathError(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return false;
	}
	const code = (error as { code?: unknown }).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

export async function inspectRuntimeProjectAvailability(
	projectPath: string,
	dependencies: RuntimeProjectAvailabilityInspectionDependencies = defaultRuntimeProjectAvailabilityInspectionDependencies,
): Promise<RuntimeProjectAvailability> {
	let projectPathStat: RuntimeProjectPathStat;
	try {
		projectPathStat = await dependencies.statProjectPath(projectPath);
	} catch (error) {
		return isMissingProjectPathError(error)
			? { status: "unavailable", reason: "project_path_missing" }
			: { status: "unavailable", reason: "project_path_access_could_not_be_verified" };
	}

	if (!projectPathStat.isDirectory()) {
		return { status: "unavailable", reason: "project_path_not_directory" };
	}

	return (await dependencies.verifyGitWorkTree(projectPath))
		? { status: "available" }
		: { status: "unavailable", reason: "git_work_tree_unavailable" };
}
