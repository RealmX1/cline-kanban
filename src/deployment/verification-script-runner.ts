import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type {
	RuntimePostDeployVerificationChecklistItem,
	RuntimePostDeployVerificationRun,
} from "../core/api-contract";
import { getKanbanRuntimeHost, getKanbanRuntimePort } from "../core/runtime-endpoint";
import { getVerificationAssetsDir } from "./verification-assets";

// 脚本输出摘录上限（尾部截断）：面板展示 + 落盘 run.outputExcerpt，避免大输出撑爆 state 文件。
const OUTPUT_EXCERPT_MAX_CHARS = 4000;

// 运行期输出缓冲上限：stdout/stderr 累积时即裁剪保留尾部（约 2× 摘录上限），
// 防止高输出或卡到 timeout 的脚本在 live server 进程内无界占用内存；最终摘录仍由 tailExcerpt 截到摘录上限。
const RUNNING_OUTPUT_BUFFER_MAX_CHARS = OUTPUT_EXCERPT_MAX_CHARS * 2;

function capRunningOutputBufferTail(buffer: string): string {
	if (buffer.length <= RUNNING_OUTPUT_BUFFER_MAX_CHARS) {
		return buffer;
	}
	return buffer.slice(buffer.length - RUNNING_OUTPUT_BUFFER_MAX_CHARS);
}

function tailExcerpt(text: string): string {
	if (text.length <= OUTPUT_EXCERPT_MAX_CHARS) {
		return text;
	}
	return `…（已截断，保留尾部 ${OUTPUT_EXCERPT_MAX_CHARS} 字符）\n${text.slice(text.length - OUTPUT_EXCERPT_MAX_CHARS)}`;
}

// 执行侧路径护栏（与 cleanupVerificationAssets 的删除侧 realpath 护栏对称）：
// entrypoint 必须是相对路径，且 realpath(join(assetsDir, entrypoint)) 严格位于资产目录之下（symlink 逃逸同样拒绝）。
// 校验失败时不 spawn，由调用方以 errored 结束。
async function resolveEntrypointPathInsideAssetsDir(
	assetsDir: string,
	entrypoint: string,
): Promise<{ ok: true; resolvedEntrypointPath: string } | { ok: false; reason: string }> {
	if (isAbsolute(entrypoint)) {
		return { ok: false, reason: `entrypoint 必须是资产目录内的相对路径，不允许绝对路径：${entrypoint}` };
	}
	let resolvedAssetsDir: string;
	try {
		resolvedAssetsDir = await realpath(assetsDir);
	} catch (error) {
		return {
			ok: false,
			reason: `资产目录不可用：${assetsDir}（${error instanceof Error ? error.message : String(error)}）`,
		};
	}
	let resolvedEntrypointPath: string;
	try {
		resolvedEntrypointPath = await realpath(join(assetsDir, entrypoint));
	} catch (error) {
		return {
			ok: false,
			reason: `entrypoint 无法解析：${entrypoint}（${error instanceof Error ? error.message : String(error)}）`,
		};
	}
	const relFromAssetsDir = relative(resolvedAssetsDir, resolvedEntrypointPath);
	if (relFromAssetsDir === "" || relFromAssetsDir.startsWith("..") || isAbsolute(relFromAssetsDir)) {
		return {
			ok: false,
			reason: `entrypoint 解析后越界（不在资产目录 ${resolvedAssetsDir} 之下）：${entrypoint} → ${resolvedEntrypointPath}`,
		};
	}
	return { ok: true, resolvedEntrypointPath };
}

// 自动脚本运行结果（不含 running 中间态；running 由 state 模块的 setVerificationRunState 单独落盘）。
export interface VerificationScriptRunOutcome {
	status: "passed" | "failed" | "errored" | "timed_out";
	exitCode: number | null;
	outputExcerpt: string;
	startedAtIso: string;
	finishedAtIso: string;
}

// 在资产目录内 spawn 自动脚本并等待完成。cwd=assetsDir，注入 runtime 端点 + verificationId 供脚本回观察运行实例。
// spawn 前先做 entrypoint 路径护栏（相对路径 + realpath 落在资产目录内），校验失败→errored 且不 spawn。
// 退出码 0=passed，非 0=failed；超时 kill→timed_out；spawn/其它异常→errored。时间戳由调用方注入以保持可测。
export async function runVerificationScript(input: {
	verificationId: string;
	script: NonNullable<RuntimePostDeployVerificationChecklistItem["script"]>;
	startedAtIso: string;
	finishedAtIsoProvider: () => string;
}): Promise<VerificationScriptRunOutcome> {
	const { verificationId, script } = input;
	const assetsDir = getVerificationAssetsDir(verificationId);
	const command = script.interpreter === "node" ? "node" : "bash";

	const entrypointCheck = await resolveEntrypointPathInsideAssetsDir(assetsDir, script.entrypoint);
	if (!entrypointCheck.ok) {
		return {
			status: "errored",
			exitCode: null,
			outputExcerpt: `entrypoint 校验失败：${entrypointCheck.reason}`,
			startedAtIso: input.startedAtIso,
			finishedAtIso: input.finishedAtIsoProvider(),
		};
	}

	return await new Promise<VerificationScriptRunOutcome>((resolve) => {
		let stdoutBuffer = "";
		let stderrBuffer = "";
		let settled = false;
		let timedOut = false;

		const finish = (outcome: Omit<VerificationScriptRunOutcome, "startedAtIso" | "finishedAtIso">): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutHandle);
			resolve({
				...outcome,
				startedAtIso: input.startedAtIso,
				finishedAtIso: input.finishedAtIsoProvider(),
			});
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, [entrypointCheck.resolvedEntrypointPath], {
				cwd: assetsDir,
				env: {
					...process.env,
					KANBAN_RUNTIME_HOST: getKanbanRuntimeHost(),
					KANBAN_RUNTIME_PORT: String(getKanbanRuntimePort()),
					KANBAN_VERIFICATION_ID: verificationId,
				},
			});
		} catch (error) {
			finish({
				status: "errored",
				exitCode: null,
				outputExcerpt: `spawn 失败：${error instanceof Error ? error.message : String(error)}`,
			});
			return;
		}

		const timeoutHandle = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, script.timeoutMs);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutBuffer = capRunningOutputBufferTail(stdoutBuffer + chunk.toString("utf8"));
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBuffer = capRunningOutputBufferTail(stderrBuffer + chunk.toString("utf8"));
		});
		child.on("error", (error) => {
			finish({
				status: "errored",
				exitCode: null,
				outputExcerpt: tailExcerpt(
					`${stdoutBuffer}${stderrBuffer}\n进程错误：${error instanceof Error ? error.message : String(error)}`,
				),
			});
		});
		child.on("close", (code) => {
			const combined = tailExcerpt(`${stdoutBuffer}${stderrBuffer}`);
			if (timedOut) {
				finish({ status: "timed_out", exitCode: code, outputExcerpt: combined });
				return;
			}
			finish({
				status: code === 0 ? "passed" : "failed",
				exitCode: code,
				outputExcerpt: combined,
			});
		});
	});
}

// 把运行结果转成落盘的 run 快照。
export function toRunSnapshot(outcome: VerificationScriptRunOutcome): RuntimePostDeployVerificationRun {
	return {
		status: outcome.status,
		exitCode: outcome.exitCode,
		startedAtIso: outcome.startedAtIso,
		finishedAtIso: outcome.finishedAtIso,
		outputExcerpt: outcome.outputExcerpt,
	};
}
