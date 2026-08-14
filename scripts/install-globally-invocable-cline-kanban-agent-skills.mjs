#!/usr/bin/env node
// 把本仓库中「需要在任意仓库里按名调用」的 agent skill 幂等符号链接进各 harness 的全局 skill 目录。
//
// 只有跨仓库消费的 skill 才进这个白名单；仅在本仓库内使用的 skill 继续走 .claude/skills 项目内链接，
// 同一个 skill 不得同时占据 project 与 personal 两个 scope。

import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const GLOBALLY_INVOCABLE_SKILL_NAMES = ["cline-kanban-survey-sibling-task-work-in-same-workspace"];
const ALWAYS_INSTALLED_HARNESS_HOME_DIRECTORY_NAMES = [".claude", ".codex"];
const INSTALLED_ONLY_IF_HARNESS_HOME_EXISTS_DIRECTORY_NAMES = [".hermes"];
const CLINE_TASK_WORKTREE_PATH_FRAGMENT = `${sep}.cline${sep}worktrees${sep}`;

const repositoryRootPath = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

function fail(message) {
	process.stderr.write(`AGENT_SKILL_INSTALL_STATUS=REFUSED\n${message}\n`);
	process.exit(2);
}

// 全局链接指向一个 checkout；若从任务 worktree 安装，链接会指向随时会消失的临时目录。
// 这个失误在本机已经反复发生过，所以在这里 fail closed 而不是提示一句了事。
function assertInstallingFromDurableMainCheckout() {
	const gitEntryPath = join(repositoryRootPath, ".git");
	if (!existsSync(gitEntryPath)) fail(`不是 git checkout: ${repositoryRootPath}`);
	if (!lstatSync(gitEntryPath).isDirectory()) {
		fail(`${repositoryRootPath} 是 linked git worktree（.git 是文件）。必须从 cline-kanban 主 checkout 运行本安装器。`);
	}
	if (`${repositoryRootPath}${sep}`.includes(CLINE_TASK_WORKTREE_PATH_FRAGMENT)) {
		fail(`${repositoryRootPath} 位于 cline 任务 worktree 下。必须从 cline-kanban 主 checkout 运行本安装器。`);
	}
}

function resolveHarnessSkillDirectoryPaths() {
	const harnessSkillDirectoryPaths = [];
	for (const harnessHomeDirectoryName of ALWAYS_INSTALLED_HARNESS_HOME_DIRECTORY_NAMES) {
		harnessSkillDirectoryPaths.push(join(homedir(), harnessHomeDirectoryName, "skills"));
	}
	for (const harnessHomeDirectoryName of INSTALLED_ONLY_IF_HARNESS_HOME_EXISTS_DIRECTORY_NAMES) {
		const harnessHomePath = join(homedir(), harnessHomeDirectoryName);
		if (existsSync(harnessHomePath)) harnessSkillDirectoryPaths.push(join(harnessHomePath, "skills"));
	}
	return harnessSkillDirectoryPaths;
}

function lstatSafe(candidatePath) {
	try {
		return lstatSync(candidatePath);
	} catch {
		return null;
	}
}

function installSkillLink(skillSourcePath, skillLinkPath, backupSuffix) {
	const existingEntryStat = lstatSafe(skillLinkPath);
	if (!existingEntryStat) {
		if (!dryRun) symlinkSync(skillSourcePath, skillLinkPath);
		return "LINKED";
	}
	if (existingEntryStat.isSymbolicLink()) {
		const currentTargetPath = resolve(dirname(skillLinkPath), readlinkSync(skillLinkPath));
		if (currentTargetPath === skillSourcePath) return "ALREADY_LINKED";
		if (!dryRun) {
			rmSync(skillLinkPath);
			symlinkSync(skillSourcePath, skillLinkPath);
		}
		return "RELINKED";
	}
	if (!dryRun) {
		renameSync(skillLinkPath, `${skillLinkPath}.bak.${backupSuffix}`);
		symlinkSync(skillSourcePath, skillLinkPath);
	}
	return "BACKED_UP_AND_LINKED";
}

assertInstallingFromDurableMainCheckout();
const backupSuffix = new Date().toISOString().replace(/[:.]/g, "-");
process.stdout.write(`INSTALL_SOURCE_CHECKOUT=${repositoryRootPath}\n`);
process.stdout.write(`DRY_RUN=${dryRun ? "1" : "0"}\n`);

for (const skillName of GLOBALLY_INVOCABLE_SKILL_NAMES) {
	const skillSourcePath = join(repositoryRootPath, ".codex", "skills", skillName);
	if (!existsSync(join(skillSourcePath, "SKILL.md"))) fail(`缺少 skill 源目录: ${skillSourcePath}`);
	const projectLocalLinkPath = join(repositoryRootPath, ".claude", "skills", skillName);
	if (lstatSafe(projectLocalLinkPath)) {
		fail(
			`${relative(repositoryRootPath, projectLocalLinkPath)} 与全局安装冲突：` +
				"同一个 skill 不得同时以 project 与 personal scope 出现，请先删除项目内链接。",
		);
	}
	for (const harnessSkillDirectoryPath of resolveHarnessSkillDirectoryPaths()) {
		if (!dryRun) mkdirSync(harnessSkillDirectoryPath, { recursive: true });
		const skillLinkPath = join(harnessSkillDirectoryPath, skillName);
		const outcome = installSkillLink(skillSourcePath, skillLinkPath, backupSuffix);
		process.stdout.write(`${outcome}: ${skillLinkPath} -> ${skillSourcePath}\n`);
	}
}

process.stdout.write("AGENT_SKILL_INSTALL_STATUS=COMPLETED\n");
