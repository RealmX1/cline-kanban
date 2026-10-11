import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { createTempDir } from "../../utilities/temp-dir";

const promotionScriptPath = fileURLToPath(
	new URL("../../../scripts/promote-staged-kanban-build-output-into-distribution-directory.mjs", import.meta.url),
);

interface PromotionScriptResult {
	promotedRelativeFilePathsInPromotionOrder: string[];
	removedStaleRelativeFilePaths: string[];
}

function writeFileCreatingParentDirectories(filePath: string, content: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content);
}

function createStagingAndDistributionDirectories(): {
	stagingDirectoryPath: string;
	distributionDirectoryPath: string;
} {
	const temporaryDirectory = createTempDir("kanban-atomic-build-promotion-");
	onTestFinished(() => temporaryDirectory.cleanup());
	const distributionDirectoryPath = join(temporaryDirectory.path, "dist");
	const stagingDirectoryPath = join(distributionDirectoryPath, ".kanban-build-staging-1-test");
	mkdirSync(stagingDirectoryPath, { recursive: true });
	return { stagingDirectoryPath, distributionDirectoryPath };
}

function runPromotionScript(stagingDirectoryPath: string, distributionDirectoryPath: string): PromotionScriptResult {
	const stdout = execFileSync(
		process.execPath,
		[
			promotionScriptPath,
			"--staging-directory",
			stagingDirectoryPath,
			"--distribution-directory",
			distributionDirectoryPath,
		],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	return JSON.parse(stdout) as PromotionScriptResult;
}

describe("promote-staged-kanban-build-output-into-distribution-directory", () => {
	it("promotes content-hashed assets before web-ui/index.html and promotes cli.js last", () => {
		const { stagingDirectoryPath, distributionDirectoryPath } = createStagingAndDistributionDirectories();
		for (const relativeFilePath of [
			"cli.js",
			"cli.js.map",
			"index.js",
			"notification-lifecycle-database-worker.mjs",
			"web-ui/index.html",
			"web-ui/sw.js",
			"web-ui/assets/index-NEW.js",
			"web-ui/assets/sounds/ding.mp3",
		]) {
			writeFileCreatingParentDirectories(join(stagingDirectoryPath, relativeFilePath), `new ${relativeFilePath}`);
		}

		const result = runPromotionScript(stagingDirectoryPath, distributionDirectoryPath);

		const promotionOrder = result.promotedRelativeFilePathsInPromotionOrder;
		expect(promotionOrder.at(-1)).toBe("cli.js");
		expect(promotionOrder.indexOf("web-ui/index.html")).toBeGreaterThan(
			promotionOrder.indexOf("web-ui/assets/index-NEW.js"),
		);
		expect(promotionOrder.indexOf("web-ui/index.html")).toBeGreaterThan(
			promotionOrder.indexOf("web-ui/assets/sounds/ding.mp3"),
		);
		expect(readFileSync(join(distributionDirectoryPath, "cli.js"), "utf8")).toBe("new cli.js");
		expect(readFileSync(join(distributionDirectoryPath, "web-ui/assets/sounds/ding.mp3"), "utf8")).toBe(
			"new web-ui/assets/sounds/ding.mp3",
		);
	});

	it("removes stale files and emptied directories only inside web-ui and keeps unowned top-level files", () => {
		const { stagingDirectoryPath, distributionDirectoryPath } = createStagingAndDistributionDirectories();
		writeFileCreatingParentDirectories(join(distributionDirectoryPath, "web-ui/index.html"), "old index");
		writeFileCreatingParentDirectories(join(distributionDirectoryPath, "web-ui/assets/index-OLD.js"), "old asset");
		writeFileCreatingParentDirectories(
			join(distributionDirectoryPath, "web-ui/assets/obsolete/chunk.js"),
			"old chunk",
		);
		writeFileCreatingParentDirectories(join(distributionDirectoryPath, "unowned-top-level-file.txt"), "keep me");
		writeFileCreatingParentDirectories(join(stagingDirectoryPath, "web-ui/index.html"), "new index");
		writeFileCreatingParentDirectories(join(stagingDirectoryPath, "web-ui/assets/index-NEW.js"), "new asset");

		const result = runPromotionScript(stagingDirectoryPath, distributionDirectoryPath);

		expect(result.removedStaleRelativeFilePaths.sort()).toEqual([
			"web-ui/assets/index-OLD.js",
			"web-ui/assets/obsolete/chunk.js",
		]);
		expect(existsSync(join(distributionDirectoryPath, "web-ui/assets/obsolete"))).toBe(false);
		expect(readFileSync(join(distributionDirectoryPath, "web-ui/index.html"), "utf8")).toBe("new index");
		expect(readFileSync(join(distributionDirectoryPath, "unowned-top-level-file.txt"), "utf8")).toBe("keep me");
	});

	it("refuses to promote a staging directory that contains a symbolic link and leaves its target untouched", () => {
		const { stagingDirectoryPath, distributionDirectoryPath } = createStagingAndDistributionDirectories();
		const symbolicLinkTargetDirectoryPath = join(dirname(distributionDirectoryPath), "symbolic-link-target");
		writeFileCreatingParentDirectories(join(symbolicLinkTargetDirectoryPath, "index.html"), "must survive");
		symlinkSync(symbolicLinkTargetDirectoryPath, join(stagingDirectoryPath, "web-ui"));

		expect(() => runPromotionScript(stagingDirectoryPath, distributionDirectoryPath)).toThrow(
			/refusing to traverse symbolic link/,
		);
		expect(readFileSync(join(symbolicLinkTargetDirectoryPath, "index.html"), "utf8")).toBe("must survive");
		expect(existsSync(join(distributionDirectoryPath, "web-ui"))).toBe(false);
	});

	it("skips stale-file cleanup when the owned web-ui directory in dist is a symbolic link", () => {
		const { stagingDirectoryPath, distributionDirectoryPath } = createStagingAndDistributionDirectories();
		const symbolicLinkTargetDirectoryPath = join(dirname(distributionDirectoryPath), "symbolic-link-target");
		writeFileCreatingParentDirectories(join(symbolicLinkTargetDirectoryPath, "assets/not-owned.js"), "must survive");
		symlinkSync(symbolicLinkTargetDirectoryPath, join(distributionDirectoryPath, "web-ui"));
		writeFileCreatingParentDirectories(join(stagingDirectoryPath, "cli.js"), "new cli");

		const result = runPromotionScript(stagingDirectoryPath, distributionDirectoryPath);

		expect(result.removedStaleRelativeFilePaths).toEqual([]);
		expect(readFileSync(join(symbolicLinkTargetDirectoryPath, "assets/not-owned.js"), "utf8")).toBe("must survive");
	});
});
