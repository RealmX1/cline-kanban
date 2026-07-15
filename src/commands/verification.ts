import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import type { Command } from "commander";
import type {
	RuntimeAuthoredVerificationDefinition,
	RuntimeAuthoredVerificationDefinitionInput,
} from "../core/api-contract";
import { parseAuthoredVerificationDefinitionInputFile } from "../core/api-validation";
import { getKanbanRuntimeOrigin } from "../core/runtime-endpoint";
import {
	listAuthoredVerificationDefinitions,
	removeAuthoredVerificationDefinition,
	upsertAuthoredVerificationDefinition,
} from "../deployment/authored-verification-definitions";
import { cleanupVerificationAssets, ensureVerificationAssetsDir } from "../deployment/verification-assets";
import { resolveProjectInputPath } from "../projects/project-path";
import { loadWorkspaceContext } from "../state/workspace-state";
import { printJson } from "./task";

type JsonRecord = Record<string, unknown>;

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

async function runVerificationCommand(handler: () => Promise<JsonRecord>): Promise<void> {
	try {
		printJson(await handler());
	} catch (error) {
		printJson({
			ok: false,
			error: `Verification command failed at ${getKanbanRuntimeOrigin()}: ${toErrorMessage(error)}`,
		});
		process.exitCode = 1;
	}
}

// 解析 --project-path / cwd 为 workspaceId（未注册 workspace 即报错，提示 --project-path）。
async function resolveWorkspaceId(
	cwd: string,
	projectPath?: string,
): Promise<{ workspaceId: string; repoPath: string }> {
	const resolutionPath = projectPath ? resolveProjectInputPath(projectPath, cwd) : cwd;
	try {
		const workspace = await loadWorkspaceContext(resolutionPath, { autoCreateIfMissing: false });
		return { workspaceId: workspace.workspaceId, repoPath: workspace.repoPath };
	} catch (error) {
		throw new Error(
			`Could not resolve a Kanban workspace for ${resolutionPath}: ${toErrorMessage(error)}. Pass --project-path to select a registered project.`,
		);
	}
}

// ---- register ----

// register 入口的 entrypoint 静态护栏（与执行侧 verification-script-runner 的逃逸风险对称，把逃逸挡在注册入口）。
// 注册时资产目录可能尚不存在、entrypoint 文件通常还没写入（realpath 会 ENOENT），因此不做存在性检查，
// 只对规范化后的路径做静态判定：拒绝绝对路径，以及 normalize 后仍指向资产目录自身（"."）或逃逸出资产目录
// （".." / "../*" 前缀）的相对路径。
export function assertVerificationScriptEntrypointStaysInsideAssetsDir(label: string, entrypoint: string): void {
	const rejectEntrypoint = (reason: string): never => {
		throw new Error(`Verification "${label}" has an invalid script.entrypoint "${entrypoint}": ${reason}`);
	};
	if (entrypoint.trim().length === 0) {
		rejectEntrypoint("entrypoint must not be empty.");
	}
	if (isAbsolute(entrypoint)) {
		rejectEntrypoint(
			"entrypoint must be a relative path inside the verification assets directory, not an absolute path.",
		);
	}
	const normalized = normalize(entrypoint);
	if (normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`)) {
		rejectEntrypoint('entrypoint must stay inside the verification assets directory (no ".." escape).');
	}
}

// 整批 register 的前置校验（纯校验、零副作用）：任一定义非法即拒绝整条 register。
// 必须在 ensureVerificationAssetsDir / upsertAuthoredVerificationDefinition 之前对全部输入跑完，
// 避免「数组前段已持久化、后段抛错」留下难以发现和清理的部分注册。
export function assertAuthoredVerificationDefinitionInputsRegisterable(
	inputs: RuntimeAuthoredVerificationDefinitionInput[],
): void {
	for (const definitionInput of inputs) {
		// automated_script 型必须带 script（Failure Gate：没有脚本入口无法运行）。
		if (definitionInput.kind === "automated_script" && definitionInput.script === null) {
			throw new Error(`automated_script verification "${definitionInput.label}" must include a script entrypoint.`);
		}
		// 任何带 script 的定义都过 entrypoint 护栏（运行触发只看 script 非空、不看 kind，guided_manual 带 script 同样可被运行）。
		if (definitionInput.script !== null) {
			assertVerificationScriptEntrypointStaysInsideAssetsDir(
				definitionInput.label,
				definitionInput.script.entrypoint,
			);
		}
	}
}

async function registerVerification(input: {
	cwd: string;
	taskId: string;
	projectPath?: string;
	definitionFile: string;
}): Promise<JsonRecord> {
	const { workspaceId } = await resolveWorkspaceId(input.cwd, input.projectPath);

	const definitionFilePath = resolve(input.cwd, input.definitionFile);
	let raw: string;
	try {
		raw = await readFile(definitionFilePath, "utf8");
	} catch (error) {
		throw new Error(`Could not read --definition-file ${definitionFilePath}: ${toErrorMessage(error)}`);
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch (error) {
		throw new Error(`--definition-file ${definitionFilePath} is not valid JSON: ${toErrorMessage(error)}`);
	}
	const parsed = parseAuthoredVerificationDefinitionInputFile(parsedJson);
	const inputs = Array.isArray(parsed) ? parsed : [parsed];
	if (inputs.length === 0) {
		throw new Error(`--definition-file ${definitionFilePath} contains no verification definitions.`);
	}

	// 先对所有输入做完整校验（automated_script 必须带 script + entrypoint 静态护栏），
	// 全部通过后才进入下面带副作用的持久化循环——保证批量 register 要么全部注册、要么零残留。
	assertAuthoredVerificationDefinitionInputsRegisterable(inputs);

	const nowIso = new Date().toISOString();
	const registered: JsonRecord[] = [];
	for (const definitionInput of inputs) {
		const verificationId = definitionInput.verificationId ?? randomUUID();
		const assetsDir = await ensureVerificationAssetsDir(verificationId);
		// cleanup.assetsDir 缺省则填规范资产目录，使 automatic 清理能定位删除目标。
		const cleanup = {
			...definitionInput.cleanup,
			assetsDir: definitionInput.cleanup.assetsDir ?? assetsDir,
		};
		const definition: RuntimeAuthoredVerificationDefinition = {
			verificationId,
			workspaceId,
			taskId: input.taskId,
			kind: definitionInput.kind,
			label: definitionInput.label,
			guidance: definitionInput.guidance,
			script: definitionInput.script,
			cleanup,
			createdAtIso: nowIso,
		};
		await upsertAuthoredVerificationDefinition(definition, nowIso);
		registered.push({
			verificationId,
			kind: definition.kind,
			label: definition.label,
			assetsDir,
			cleanupMode: cleanup.mode,
		});
	}

	return {
		ok: true,
		workspaceId,
		taskId: input.taskId,
		registeredCount: registered.length,
		registered,
	};
}

// ---- list ----

async function listVerification(input: { cwd: string; taskId?: string; projectPath?: string }): Promise<JsonRecord> {
	// project-path 或 cwd 能解析出 workspace 则按之过滤；否则列全部（跨 workspace 自查）。
	let workspaceId: string | undefined;
	try {
		workspaceId = (await resolveWorkspaceId(input.cwd, input.projectPath)).workspaceId;
	} catch {
		workspaceId = undefined;
	}
	const nowIso = new Date().toISOString();
	const definitions = await listAuthoredVerificationDefinitions({ workspaceId, taskId: input.taskId }, nowIso);
	return {
		ok: true,
		workspaceId: workspaceId ?? null,
		taskId: input.taskId ?? null,
		count: definitions.length,
		definitions,
	};
}

// ---- unregister ----

async function unregisterVerification(input: { verificationId: string }): Promise<JsonRecord> {
	const nowIso = new Date().toISOString();
	const removed = await removeAuthoredVerificationDefinition(input.verificationId, nowIso);
	return { ok: true, verificationId: input.verificationId, removed };
}

// ---- cleanup ----

// 手动触发某验证的资产清理（同护栏：只删 verifications 根目录下的真实路径）并注销其 pending 定义。
async function cleanupVerification(input: { verificationId: string }): Promise<JsonRecord> {
	const nowIso = new Date().toISOString();
	const cleanup = await cleanupVerificationAssets(input.verificationId);
	const definitionRemoved = await removeAuthoredVerificationDefinition(input.verificationId, nowIso);
	return {
		ok: true,
		verificationId: input.verificationId,
		assetsRemoved: cleanup.removed,
		...(cleanup.skippedReason ? { assetsSkippedReason: cleanup.skippedReason } : {}),
		definitionRemoved,
	};
}

export function registerVerificationCommand(program: Command): void {
	const verification = program
		.command("verification")
		.description("Author, list, and remove Post-Deploy Verification definitions from the CLI.");

	verification
		.command("register")
		.description("Register one or more authored verification definitions from a JSON file for a task.")
		.requiredOption("--task-id <id>", "Task id the verifications belong to.")
		.requiredOption("--definition-file <path>", "Path to a JSON file (single object or array of definitions).")
		.option("--project-path <path>", "Registered project. Defaults to matching the current directory.")
		.action(async (options: { taskId: string; definitionFile: string; projectPath?: string }) => {
			await runVerificationCommand(
				async () =>
					await registerVerification({
						cwd: process.cwd(),
						taskId: options.taskId,
						projectPath: options.projectPath,
						definitionFile: options.definitionFile,
					}),
			);
		});

	verification
		.command("list")
		.description("List registered authored verification definitions (optionally filtered by task / project).")
		.option("--task-id <id>", "Filter to a single task id.")
		.option("--project-path <path>", "Filter to a single project. Defaults to the current directory workspace.")
		.action(async (options: { taskId?: string; projectPath?: string }) => {
			await runVerificationCommand(
				async () =>
					await listVerification({
						cwd: process.cwd(),
						taskId: options.taskId,
						projectPath: options.projectPath,
					}),
			);
		});

	verification
		.command("unregister")
		.description("Remove a pending authored verification definition by id (does not touch already-seeded groups).")
		.requiredOption("--verification-id <id>", "Verification id to remove.")
		.action(async (options: { verificationId: string }) => {
			await runVerificationCommand(
				async () => await unregisterVerification({ verificationId: options.verificationId }),
			);
		});

	verification
		.command("cleanup")
		.description("Remove a verification's asset directory (guarded to the verifications root) and unregister it.")
		.requiredOption("--verification-id <id>", "Verification id whose assets to clean up.")
		.action(async (options: { verificationId: string }) => {
			await runVerificationCommand(
				async () => await cleanupVerification({ verificationId: options.verificationId }),
			);
		});
}
