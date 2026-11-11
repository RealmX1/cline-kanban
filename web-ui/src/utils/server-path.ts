/**
 * Utilities for handling server paths that may use either forward slashes (Unix)
 * or backslashes (Windows).  Following the established codebase convention, all
 * helpers normalise backslashes to forward slashes first and then work
 * exclusively with "/".
 */

/**
 * Normalise a server path by replacing all backslashes with forward slashes.
 * This is the standard convention used across the codebase (path-display,
 * file-url, top-bar, is-binary-file-path, etc.).
 */
export function normalizeServerPath(pathValue: string): string {
	return pathValue.replaceAll("\\", "/");
}

/** 按宿主已登记项目的直接父目录计数；并列时保留项目列表中最先出现的目录。 */
export function deriveMostCommonRegisteredProjectParentDirectoryPath(
	registeredProjectPaths: readonly string[],
): string | null {
	const projectCountByParentDirectory = new Map<string, number>();
	for (const projectPath of registeredProjectPaths) {
		const normalizedProjectPath = normalizeServerPath(projectPath).replace(/\/+$/, "");
		const parentSeparatorIndex = normalizedProjectPath.lastIndexOf("/");
		if (parentSeparatorIndex < 0) continue;
		const parentDirectoryPath = normalizedProjectPath.slice(0, parentSeparatorIndex + 1);
		projectCountByParentDirectory.set(
			parentDirectoryPath,
			(projectCountByParentDirectory.get(parentDirectoryPath) ?? 0) + 1,
		);
	}
	let mostCommonParentDirectoryPath: string | null = null;
	let highestProjectCount = 0;
	for (const [parentDirectoryPath, projectCount] of projectCountByParentDirectory) {
		if (projectCount <= highestProjectCount) continue;
		mostCommonParentDirectoryPath = parentDirectoryPath;
		highestProjectCount = projectCount;
	}
	return mostCommonParentDirectoryPath;
}

/**
 * Split a server path into segments, normalising separators first.
 */
export function splitServerPath(pathValue: string): string[] {
	return normalizeServerPath(pathValue).split("/").filter(Boolean);
}

/**
 * Build an absolute server path by joining `rootPath` with a relative
 * `uiPath`.  Both inputs are normalised to "/" before joining.
 */
export function toServerAbsolute(rootPath: string, uiPath: string): string {
	const root = normalizeServerPath(rootPath).replace(/\/+$/, "");
	const parts = normalizeServerPath(uiPath).split("/").filter(Boolean);
	return [root, ...parts].join("/");
}

/**
 * Strip the `rootPath` prefix from an absolute path to get the relative
 * portion.  Returns an empty string when the paths are equal.
 */
export function toUiRelative(rootPath: string, absolutePath: string): string {
	const normalizedRoot = normalizeServerPath(rootPath).replace(/\/+$/, "");
	const normalizedAbsolute = normalizeServerPath(absolutePath);
	if (normalizedAbsolute === normalizedRoot) {
		return "";
	}
	const afterRoot = normalizedAbsolute.slice(normalizedRoot.length);
	return afterRoot.replace(/^\/+/, "");
}

/**
 * Produce a short display label for the server root breadcrumb.
 * For Windows paths like "C:/foo" it returns "C:/"; otherwise "/".
 */
export function serverRootLabel(rootPath: string): string {
	const normalized = normalizeServerPath(rootPath);
	const winDriveMatch = normalized.match(/^[A-Za-z]:\/?/);
	if (winDriveMatch) {
		const drive = winDriveMatch[0];
		return drive.endsWith("/") ? drive : `${drive}/`;
	}
	return "/";
}
