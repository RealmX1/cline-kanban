import { describe, expect, it, vi } from "vitest";

import { inspectRuntimeProjectAvailability } from "../../../src/server/runtime-project-availability";

function createFileSystemError(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("inspectRuntimeProjectAvailability", () => {
	it("reports an available Git work tree without mutating the project", async () => {
		const statProjectPath = vi.fn(async () => ({ isDirectory: () => true }));
		const verifyGitWorkTree = vi.fn(async () => true);

		await expect(
			inspectRuntimeProjectAvailability("/projects/healthy", {
				statProjectPath,
				verifyGitWorkTree,
			}),
		).resolves.toEqual({ status: "available" });
		expect(statProjectPath).toHaveBeenCalledWith("/projects/healthy");
		expect(verifyGitWorkTree).toHaveBeenCalledWith("/projects/healthy");
	});

	it.each([
		{
			label: "missing project path",
			statProjectPath: async () => {
				throw createFileSystemError("ENOENT");
			},
			expectedReason: "project_path_missing" as const,
		},
		{
			label: "project path that is not a directory",
			statProjectPath: async () => ({ isDirectory: () => false }),
			expectedReason: "project_path_not_directory" as const,
		},
		{
			label: "project path whose access cannot be verified",
			statProjectPath: async () => {
				throw createFileSystemError("EACCES");
			},
			expectedReason: "project_path_access_could_not_be_verified" as const,
		},
	])("distinguishes $label without running Git", async ({ statProjectPath, expectedReason }) => {
		const verifyGitWorkTree = vi.fn(async () => true);
		await expect(
			inspectRuntimeProjectAvailability("/projects/unavailable", {
				statProjectPath,
				verifyGitWorkTree,
			}),
		).resolves.toEqual({ status: "unavailable", reason: expectedReason });
		expect(verifyGitWorkTree).not.toHaveBeenCalled();
	});

	it("reports a directory whose Git work tree cannot be verified as unavailable", async () => {
		await expect(
			inspectRuntimeProjectAvailability("/projects/bare", {
				statProjectPath: async () => ({ isDirectory: () => true }),
				verifyGitWorkTree: async () => false,
			}),
		).resolves.toEqual({ status: "unavailable", reason: "git_work_tree_unavailable" });
	});
});
