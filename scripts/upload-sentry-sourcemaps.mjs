import { spawnSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative, resolve, sep } from "node:path";

const SENTRY_ORG = "cline-bot-inc-xi";
const SENTRY_WEB_PROJECT = "kanban-react";
const SENTRY_NODE_PROJECT = "kanban-node";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(scriptDir, "..");
// scripts/build.mjs 在把产物换入 dist 之前，用这个变量指向它的暂存目录：inject 会改写产物，必须在换入前做。
const distDir = resolve(process.env.KANBAN_SENTRY_SOURCEMAP_UPLOAD_DISTRIBUTION_DIRECTORY ?? resolve(repoRoot, "dist"));
const webDistDir = resolve(distDir, "web-ui");
const stagingRoot = resolve(repoRoot, ".sentry-artifacts");
const nodeStagingDir = resolve(stagingRoot, "node");
const sentryCliBinary = resolve(
	repoRoot,
	"node_modules",
	".bin",
	process.platform === "win32" ? "sentry-cli.exe" : "sentry-cli",
);

function runSentryCli(args) {
	const result = spawnSync(sentryCliBinary, args, {
		cwd: repoRoot,
		env: process.env,
		stdio: "inherit",
	});

	if (result.status !== 0) {
		const signalMessage = result.signal ? ` (signal: ${result.signal})` : "";
		throw new Error(`sentry-cli ${args.join(" ")} failed${signalMessage}`);
	}
}

function shouldCopyToNodeStaging(sourcePath) {
	const pathFromDist = relative(distDir, sourcePath);
	if (!pathFromDist) {
		return true;
	}
	if (pathFromDist === "web-ui") {
		return false;
	}
	return !pathFromDist.startsWith(`web-ui${sep}`);
}

async function main() {
	const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN?.trim();
	if (!sentryAuthToken) {
		console.log("Skipping Sentry sourcemap upload because SENTRY_AUTH_TOKEN is not set.");
		return;
	}

	await rm(stagingRoot, { force: true, recursive: true });
	await mkdir(stagingRoot, { recursive: true });

	runSentryCli(["sourcemaps", "inject", distDir]);

	await cp(distDir, nodeStagingDir, {
		filter: shouldCopyToNodeStaging,
		recursive: true,
	});

	runSentryCli(["sourcemaps", "upload", "--org", SENTRY_ORG, "--project", SENTRY_WEB_PROJECT, webDistDir]);
	runSentryCli(["sourcemaps", "upload", "--org", SENTRY_ORG, "--project", SENTRY_NODE_PROJECT, nodeStagingDir]);

	await rm(stagingRoot, { force: true, recursive: true });
}

main().catch(async (error) => {
	await rm(stagingRoot, { force: true, recursive: true });
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Failed to upload Sentry sourcemaps: ${message}`);
	process.exit(1);
});
