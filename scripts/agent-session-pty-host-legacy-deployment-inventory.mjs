import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { setTimeout as waitForSecondProcessObservation } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function collectDescendantProcessIds(processes, runtimeProcessId) {
	const descendants = new Set();
	let changed = true;
	while (changed) {
		changed = false;
		for (const process of processes) if (!descendants.has(process.processId) && (process.parentProcessId === runtimeProcessId || descendants.has(process.parentProcessId))) {
			descendants.add(process.processId);
			changed = true;
		}
	}
	return [...descendants];
}

async function readNativeProcessIdentities() {
	const { stdout } = await execFileAsync("ps", ["-Ao", "pid=,ppid=,lstart="], { env: { ...process.env, LC_ALL: "C", LANG: "C" }, timeout: 5_000, maxBuffer: 8 * 1024 * 1024 });
	return stdout.split("\n").flatMap((line) => {
		const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
		return match ? [{ processId: Number(match[1]), parentProcessId: Number(match[2]), processStartTimeText: match[3] }] : [];
	});
}

async function socketHasListener(socketPath) {
	return await new Promise((resolve) => {
		const socket = createConnection(socketPath);
		const finish = (result) => { clearTimeout(timer); socket.destroy(); resolve(result); };
		const timer = setTimeout(() => finish(true), 300);
		// 不发送 controller hello；连通只说明仍有归属待核验，不能证明会话可保留。
		socket.once("connect", () => finish(true));
		socket.once("error", (error) => finish(!["ENOENT", "ECONNREFUSED"].includes(error.code)));
	});
}

export async function readLegacyRuntimeQuiescenceEvidence({ origin, runtimeHomeDirectoryPath, readRuntimeProcedure }) {
	if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname)) throw new Error("旧版替代核验仅支持本机 loopback 实例");
	const runtimePort = Number(new URL(origin).port);
	const [config, projectResponse, listener] = await Promise.all([
		readRuntimeProcedure("runtime.getConfig"), readRuntimeProcedure("projects.list"),
		execFileAsync("lsof", ["-nP", `-iTCP:${runtimePort}`, "-sTCP:LISTEN", "-t"], { timeout: 5_000 }),
	]);
	if (config.globalConfigPath !== join(runtimeHomeDirectoryPath, "config.json")) throw new Error("旧版 API 的配置 home 与本次 runtime 身份不一致");
	const listenerProcessIds = [...new Set(listener.stdout.trim().split(/\s+/u).map(Number))];
	if (listenerProcessIds.length !== 1 || !Number.isSafeInteger(listenerProcessIds[0]) || listenerProcessIds[0] <= 0) throw new Error("本机监听进程不唯一，旧版启动归属 unknown");
	const runtimeProcessId = listenerProcessIds[0];
	const command = (await execFileAsync("ps", ["-p", String(runtimeProcessId), "-o", "command="], { timeout: 5_000 })).stdout;
	if (!/(?:kanban|\/cli\.js)(?:\s|$)/u.test(command) || !new RegExp(`\\s--port(?:=|\\s+)${runtimePort}(?:\\s|$)`, "u").test(command)) throw new Error("本机监听进程的原生启动命令不能确认为该固定端口的 Kanban runtime");
	if (!Array.isArray(projectResponse.projects)) throw new Error("旧版项目清单不可核对");
	const blockingSessions = [];
	const failures = [];
	const summaries = [];
	const projectSessionInventorySources = [];
	const unexaminedProjects = [...projectResponse.projects];
	// 有界并行；任何一个项目不可读都保留未知，不把局部清单当成完整盘点。
	await Promise.all(Array.from({ length: Math.min(4, unexaminedProjects.length) }, async () => {
		while (unexaminedProjects.length) {
			const project = unexaminedProjects.shift();
			try {
				let workspace;
				try {
					workspace = await readRuntimeProcedure("workspace.getState", project.id);
					projectSessionInventorySources.push({ workspaceId: project.id, source: "owning_runtime_api" });
				} catch (error) {
					if (error.message !== "workspace.getState HTTP 404" || !/^[a-zA-Z0-9_-]+$/u.test(project.id)) throw error;
					// 已迁走的项目不阻断整轮机器核验；盘面 facet 与两次原生子进程观察共同补证。
					workspace = { sessions: JSON.parse(await readFile(join(runtimeHomeDirectoryPath, "workspaces", project.id, "sessions.json"), "utf8")) };
					projectSessionInventorySources.push({ workspaceId: project.id, source: "persisted_sessions_and_native_process_inventory" });
				}
				if (!workspace.sessions || typeof workspace.sessions !== "object") throw new Error("会话清单缺失");
				for (const [conversationSessionId, summary] of Object.entries(workspace.sessions)) {
					// 旧 API 已提供 facet；缺 facet 时保持 unknown，绝不据 legacy state 放行。
					if (summary.liveness === undefined || summary.turnOwner === undefined || summary.userTurnKind === undefined) failures.push(`${project.id}/${conversationSessionId} 缺少完整 facet`);
					summaries.push({ workspaceId: project.id, conversationSessionId, processId: summary.pid ?? null, liveness: summary.liveness ?? "unknown" });
				}
			} catch (error) { failures.push(`项目 ${project.id} 不可完整读取：${error.message}`); }
		}
	}));
	const firstProcesses = await readNativeProcessIdentities();
	await waitForSecondProcessObservation(250);
	const secondProcesses = await readNativeProcessIdentities();
	for (const summary of summaries) if (["starting", "live", "retrying"].includes(summary.liveness) || [...firstProcesses, ...secondProcesses].some((process) => process.processId === summary.processId)) blockingSessions.push({ ...summary, ownership: "legacy_runtime_unproven", recoveryCondition: "原会话自然结束且原生进程消失后重新核验" });
	const originalRuntime = firstProcesses.find((process) => process.processId === runtimeProcessId);
	if (!originalRuntime || secondProcesses.find((process) => process.processId === runtimeProcessId)?.processStartTimeText !== originalRuntime.processStartTimeText) failures.push("盘点过程中监听进程启动身份变化，必须重新检查");
	const descendants = new Set([...collectDescendantProcessIds(firstProcesses, runtimeProcessId), ...collectDescendantProcessIds(secondProcesses, runtimeProcessId)]);
	for (const processId of descendants) if (!blockingSessions.some((session) => session.processId === processId)) blockingSessions.push({ processId, ownership: "legacy_runtime_descendant_unproven", recoveryCondition: "该 runtime 子进程自然结束后重新核验" });
	const homeHash = createHash("sha256").update(runtimeHomeDirectoryPath).digest("hex").slice(0, 12);
	for (const [directory, prefix] of [[join(runtimeHomeDirectoryPath, "agent-session-pty-host"), `p${runtimePort}-`], [`/tmp/kanban-agent-session-pty-host-${process.getuid()}`, `${homeHash}-p${runtimePort}-`]]) {
		const names = await readdir(directory).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
		for (const name of names.filter((entry) => entry.startsWith(prefix) && /^[a-f0-9]{12}\.sock$/u.test(entry.slice(prefix.length)))) if (await socketHasListener(join(directory, name))) failures.push(`旧 generation ${join(directory, name)} 仍在监听；不能仅凭 socket 或历史日志证明可接管`);
	}
	const finalListener = await execFileAsync("lsof", ["-nP", `-iTCP:${runtimePort}`, "-sTCP:LISTEN", "-t"], { timeout: 5_000 });
	if ([...new Set(finalListener.stdout.trim().split(/\s+/u).map(Number))].some((pid) => pid !== runtimeProcessId)) failures.push("盘点完成前端口归属变化");
	if (blockingSessions.length) failures.push(`${blockingSessions.length} 条旧版活会话或子进程阻止首次切换，等待自然结束`);
	return { ok: failures.length === 0, evidenceSource: "legacy_api_and_native_quiescence_inventory", checkedAtEpochMs: Date.now(), runtimeIdentity: { runtimeHomeDirectoryPath, runtimePort }, runtimeProcessId, runtimeProcessStartTimeText: originalRuntime?.processStartTimeText ?? null, configuredPersistentPreference: null, startupDecision: null, newSessionHostingMode: "legacy_quiescent_transition", failures, blockingSessions, validatedHostedSessions: [], projectCountExamined: projectResponse.projects.length, projectSessionInventorySources, continuityVerified: false };
}
