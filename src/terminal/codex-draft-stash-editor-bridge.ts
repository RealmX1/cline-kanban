import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { parseAdditionalAgentStartupArguments } from "../core/parse-additional-agent-startup-arguments";
import { getRuntimeHomePath } from "../state/runtime-home-path";

const bridgeIdentitySchema = z.object({
	workspaceId: z.string().min(1),
	conversationSessionId: z.string().min(1),
	runtimeSessionIncarnationId: z.uuid(),
});
const bridgeSpecificationSchema = bridgeIdentitySchema.extend({
	originalVisual: z.string().nullable(),
	originalEditor: z.string().nullable(),
	originalEditorArguments: z.array(z.string()).nullable(),
});
export type CodexDraftStashEditorBridgeIdentity = z.infer<typeof bridgeIdentitySchema>;
export type CodexDraftStashEditorBridge = z.infer<typeof bridgeSpecificationSchema> & { directoryPath: string };

export const codexDraftStashOperationSpecificationSchema = bridgeIdentitySchema.extend({
	operationId: z.uuid(),
	promptId: z.uuid(),
	taskId: z.string().min(1),
	createdAtMs: z.number(),
	captureDeadlineAtMs: z.number(),
	writeDeadlineAtMs: z.number(),
});
export type CodexDraftStashOperationSpecification = z.infer<typeof codexDraftStashOperationSpecificationSchema>;

const editorReservationSchema = z.discriminatedUnion("origin", [
	z.object({ origin: z.literal("manual"), invocationId: z.uuid() }),
	z.object({ origin: z.literal("stash"), operation: codexDraftStashOperationSpecificationSchema }),
]);
export type CodexDraftEditorReservation = z.infer<typeof editorReservationSchema>;

// 原文及回执必须熬过进程和机器重启；原子 rename 前同步文件，之后同步父目录。
export function writeCodexDraftStashJsonDurably(path: string, value: unknown): void {
	const stagedPath = `${path}.${randomUUID()}.pending-atomic-rename`;
	const descriptor = openSync(stagedPath, "wx", 0o600);
	try {
		writeFileSync(descriptor, JSON.stringify(value));
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	renameSync(stagedPath, path);
	if (process.platform !== "win32") {
		const parentDescriptor = openSync(join(path, ".."), "r");
		try {
			fsyncSync(parentDescriptor);
		} finally {
			closeSync(parentDescriptor);
		}
	}
}

export function readCodexDraftStashJson(path: string): unknown | null {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export function getCodexDraftStashOperationDirectory(workspaceId: string, operationId: string): string {
	z.uuid().parse(operationId);
	if (!/^[\w.-]+$/u.test(workspaceId) || workspaceId === "." || workspaceId === "..")
		throw new Error("草稿暂存 workspace 身份无效。");
	return join(getRuntimeHomePath(), "workspaces", workspaceId, "codex-draft-stash-operations", operationId);
}

export function readCodexDraftStashEditorBridge(
	identity: CodexDraftStashEditorBridgeIdentity,
): CodexDraftStashEditorBridge | null {
	// 存量会话可能没有新桥接使用的 UUID 代际；能力未就绪不能阻断原生投递或故障恢复。
	if (!bridgeIdentitySchema.safeParse(identity).success) return null;
	const directoryPath = join(
		getRuntimeHomePath(),
		"codex-draft-stash-editor-bridges",
		identity.runtimeSessionIncarnationId,
	);
	const stored = readCodexDraftStashJson(join(directoryPath, "bridge-specification.json"));
	if (stored === null) return null;
	const specification = bridgeSpecificationSchema.parse(stored);
	if (
		specification.workspaceId !== identity.workspaceId ||
		specification.conversationSessionId !== identity.conversationSessionId ||
		specification.runtimeSessionIncarnationId !== identity.runtimeSessionIncarnationId
	)
		throw new Error("草稿编辑器桥接与当前会话身份不匹配。");
	return { ...specification, directoryPath };
}

export async function prepareCodexDraftStashEditorBridge(
	input: CodexDraftStashEditorBridgeIdentity & {
		environment: NodeJS.ProcessEnv;
	},
): Promise<CodexDraftStashEditorBridge & { environmentOverrides: Record<string, string> }> {
	const identity = bridgeIdentitySchema.parse(input);
	const directoryPath = join(
		getRuntimeHomePath(),
		"codex-draft-stash-editor-bridges",
		identity.runtimeSessionIncarnationId,
	);
	mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
	const originalVisual = input.environment.VISUAL ?? null;
	const originalEditor = input.environment.EDITOR ?? null;
	let originalEditorArguments: string[] | null = null;
	try {
		const command = originalVisual ?? originalEditor;
		if (command !== null) originalEditorArguments = parseAdditionalAgentStartupArguments(command);
	} catch {
		/* 原命令无效时保留其失败语义；不能因此阻止整个 Codex 启动。 */
	}
	const specification = { ...identity, originalVisual, originalEditor, originalEditorArguments };
	writeCodexDraftStashJsonDurably(join(directoryPath, "bridge-specification.json"), specification);
	const sourceMode = import.meta.url.endsWith(".ts");
	const runnerPath = fileURLToPath(
		new URL(
			sourceMode ? "./codex-draft-stash-editor-process-entry.ts" : "./codex-draft-stash-editor.js",
			import.meta.url,
		),
	);
	const arguments_ = [
		process.execPath,
		"--no-warnings",
		...(sourceMode ? ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href] : []),
		runnerPath,
		directoryPath,
	];
	const editorCommand = arguments_.map((argument) => `'${argument.replaceAll("'", "'\\''")}'`).join(" ");
	return { ...specification, directoryPath, environmentOverrides: { VISUAL: editorCommand, EDITOR: editorCommand } };
}

export function readCodexDraftEditorReservation(
	bridge: CodexDraftStashEditorBridge,
): CodexDraftEditorReservation | null {
	const stored = readCodexDraftStashJson(join(bridge.directoryPath, "editor-invocation-reservation", "intent.json"));
	return stored === null ? null : editorReservationSchema.parse(stored);
}

export function reserveCodexDraftEditorInvocation(
	bridge: CodexDraftStashEditorBridge,
	reservation: CodexDraftEditorReservation,
): boolean {
	const reservationDirectoryPath = join(bridge.directoryPath, "editor-invocation-reservation");
	try {
		mkdirSync(reservationDirectoryPath, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
	try {
		writeCodexDraftStashJsonDurably(join(reservationDirectoryPath, "intent.json"), reservation);
	} catch (error) {
		rmSync(reservationDirectoryPath, { recursive: true, force: true });
		throw error;
	}
	return true;
}

export function releaseCodexDraftEditorReservation(
	bridge: CodexDraftStashEditorBridge,
	expectedOperationId?: string,
): void {
	if (expectedOperationId) {
		const reservation = readCodexDraftEditorReservation(bridge);
		if (reservation?.origin !== "stash" || reservation.operation.operationId !== expectedOperationId) return;
	}
	rmSync(join(bridge.directoryPath, "editor-invocation-reservation"), { recursive: true, force: true });
}

const editorDecisionSchema = z.object({
	operationId: z.uuid(),
	allowClear: z.boolean(),
	clearAllowedUntilMs: z.number(),
});

// 此函数在 Codex 启动的编辑器子进程执行；非零退出才能让 Codex 保留原始 composer（包括末尾空白）。
export async function runCodexDraftStashEditorInvocation(
	directoryPath: string,
	nativeEditorFilePath: string,
): Promise<number> {
	const specification = bridgeSpecificationSchema.parse(
		readCodexDraftStashJson(join(directoryPath, "bridge-specification.json")),
	);
	const bridge = { ...specification, directoryPath };
	const reservation = readCodexDraftEditorReservation(bridge);
	if (!reservation || reservation.origin === "manual") {
		const environment = { ...process.env };
		if (bridge.originalVisual === null) delete environment.VISUAL;
		else environment.VISUAL = bridge.originalVisual;
		if (bridge.originalEditor === null) delete environment.EDITOR;
		else environment.EDITOR = bridge.originalEditor;
		try {
			if (!bridge.originalEditorArguments?.length) return 1;
			return await new Promise<number>((resolveExit) => {
				const child = spawn(
					bridge.originalEditorArguments?.[0] ?? "",
					[...(bridge.originalEditorArguments?.slice(1) ?? []), nativeEditorFilePath],
					{ stdio: "inherit", env: environment },
				);
				child.once("error", () => resolveExit(1));
				child.once("exit", (code) => resolveExit(code ?? 1));
			});
		} finally {
			if (reservation?.origin === "manual") releaseCodexDraftEditorReservation(bridge);
		}
	}
	const operation = reservation.operation;
	const operationDirectoryPath = getCodexDraftStashOperationDirectory(operation.workspaceId, operation.operationId);
	const persist = (name: string, value: unknown) =>
		writeCodexDraftStashJsonDurably(join(operationDirectoryPath, name), value);
	let exitCode = 1;
	let claimedThisInvocation = false;
	try {
		if (
			operation.runtimeSessionIncarnationId !== bridge.runtimeSessionIncarnationId ||
			operation.workspaceId !== bridge.workspaceId ||
			operation.conversationSessionId !== bridge.conversationSessionId
		)
			throw new Error("草稿导出归属已失效。");
		const claimDescriptor = openSync(join(operationDirectoryPath, "editor-invocation-claimed"), "wx", 0o600);
		closeSync(claimDescriptor);
		claimedThisInvocation = true;
		// 先声明执行再检查期限，状态查询才能证明过期且未声明的操作不会迟到捕获正文。
		if (Date.now() > operation.captureDeadlineAtMs) return 1;
		const text = readFileSync(nativeEditorFilePath, "utf8");
		// 只拒绝处理不完整的附件；绝不据占位文字拼装或改写正文。
		if (/\[Image #\d+\]/u.test(text)) {
			persist("failure.json", {
				outcome: "input_box_contains_unsupported_attachments",
				error: "附件草稿尚不支持无损暂存，原稿已保留。",
			});
			return 1;
		}
		persist("captured-draft.json", { text });
		while (Date.now() <= operation.writeDeadlineAtMs) {
			const rawDecision = readCodexDraftStashJson(join(operationDirectoryPath, "editor-decision.json"));
			if (rawDecision !== null) {
				const decision = editorDecisionSchema.parse(rawDecision);
				if (
					decision.operationId !== operation.operationId ||
					!decision.allowClear ||
					Date.now() > decision.clearAllowedUntilMs
				)
					return 1;
				if (!existsSync(join(operationDirectoryPath, "prompt-saved.json"))) return 1;
				// 最后一步不跨 await；旧进程的文件不会被交给下一代会话使用。
				const descriptor = openSync(nativeEditorFilePath, "w");
				try {
					fsyncSync(descriptor);
				} finally {
					closeSync(descriptor);
				}
				exitCode = 0;
				return exitCode;
			}
			await delay(40);
		}
		return 1;
	} finally {
		if (claimedThisInvocation || !existsSync(join(operationDirectoryPath, "editor-invocation-claimed")))
			persist("editor-finished.json", { exitCode, finishedAtMs: Date.now() });
	}
}
