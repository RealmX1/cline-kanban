// 只读核对真实运行实例；不发送 prompt、不回退会话、不改任务或验证状态。
import { access, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function loadInstalledWebSocket() {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const candidate = join(directory, process.platform === "win32" ? "kanban.cmd" : "kanban");
		try {
			await access(candidate);
			return createRequire(await realpath(candidate))("ws").WebSocket;
		} catch { /* 继续寻找实际安装的 Kanban 及其依赖。 */ }
	}
	throw new Error("无法从已安装的 Kanban 定位 WebSocket 依赖。");
}

async function readNativeInputAvailability(WebSocket, endpoint, nativeSessionId) {
	const socket = new WebSocket(`ws+unix://${endpoint.socketPath}:/`);
	const pending = new Map();
	let sequence = 0;
	const rejectPending = (error) => {
		for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
		pending.clear();
	};
	socket.on("error", () => rejectPending(new Error("原生控制面连接失败。")));
	socket.on("close", () => rejectPending(new Error("原生控制面连接提前关闭。")));
	socket.on("message", (bytes) => {
		let frame;
		try { frame = JSON.parse(String(bytes)); }
		catch { rejectPending(new Error("原生控制面返回无效 JSON。")); return; }
		const request = pending.get(frame.id);
		if (!request) return;
		pending.delete(frame.id); clearTimeout(request.timer);
		if (Object.hasOwn(frame, "result") === Object.hasOwn(frame, "error")) request.reject(new Error("原生响应 envelope 无效。"));
		else if (frame.error) request.reject(new Error("原生只读查询被拒绝。"));
		else request.resolve(frame.result);
	});
	const request = (method, params) => new Promise((resolve, reject) => {
		const id = ++sequence;
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`原生查询超时：${method}`)); }, 2000);
		pending.set(id, { resolve, reject, timer });
		socket.send(JSON.stringify({ id, method, params }));
	});
	try {
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => { socket.terminate(); reject(new Error("原生连接超时。")); }, 2000);
			socket.once("open", () => { clearTimeout(timer); resolve(); });
			socket.once("error", () => { clearTimeout(timer); reject(new Error("原生控制面不可达。")); });
		});
		await request("initialize", { clientInfo: { name: "kanban_codex_idle_state_verification", version: "1" }, capabilities: { experimentalApi: true } });
		socket.send(JSON.stringify({ method: "initialized" }));
		const loaded = await request("thread/loaded/list", { cursor: null, limit: 100 });
		if (!Array.isArray(loaded.data) || !loaded.data.includes(nativeSessionId)) throw new Error("本代宿主没有加载摘要所绑定的原生会话。");
		const value = await request("thread/read", { threadId: nativeSessionId, includeTurns: false });
		if (value.thread?.id !== nativeSessionId || typeof value.thread?.status?.type !== "string") throw new Error("原生会话身份或状态无法核验。");
		return value.thread;
	} finally {
		rejectPending(new Error("只读核验结束。"));
		socket.terminate();
	}
}

async function main() {
	const host = process.env.KANBAN_RUNTIME_HOST ?? "127.0.0.1";
	const port = process.env.KANBAN_RUNTIME_PORT ?? "3484";
	const scheme = process.env.KANBAN_RUNTIME_HTTPS === "1" ? "https" : "http";
	const base = `${scheme}://${host}:${port}/api/trpc/`;
	async function query(procedure, workspaceId) {
		const response = await fetch(`${base}${procedure}`, { headers: workspaceId ? { "x-kanban-workspace-id": workspaceId } : {}, signal: AbortSignal.timeout(10_000) });
		const envelope = await response.json();
		if (!response.ok || !envelope.result || !Object.hasOwn(envelope.result, "data")) throw new Error(`运行时只读查询失败：${procedure}（HTTP ${response.status}）。`);
		return envelope.result.data;
	}
	const WebSocket = await loadInstalledWebSocket();
	const { projects } = await query("projects.list");
	const targets = [];
	for (const project of projects) {
		if (project.availability?.status !== "available") continue;
		const state = await query("workspace.getState", project.id);
		for (const summary of Object.values(state.sessions)) {
			if (summary.agentId !== "codex" || summary.turnOwner !== "user" || summary.liveness !== "live" || !["review", "needs_input"].includes(summary.userTurnKind)) continue;
			const endpoint = summary.codexNativeSessionControlEndpoint;
			if (!endpoint || endpoint.workspaceId !== project.id || endpoint.conversationSessionId !== summary.taskId || endpoint.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId) continue;
			targets.push({ workspaceId: project.id, summary });
		}
	}
	let idleVerified = 0;
	const failures = [];
	const observations = [];
	for (let offset = 0; offset < targets.length; offset += 4) {
		await Promise.all(targets.slice(offset, offset + 4).map(async ({ workspaceId, summary }) => {
			try {
				const nativeId = summary.agentNativeConversationSessionIdentity?.nativeSessionId;
				if (!nativeId) throw new Error("缺少原生会话身份。");
				const thread = await readNativeInputAvailability(WebSocket, summary.codexNativeSessionControlEndpoint, nativeId);
				if (thread.status.type === "active") return;
				if (thread.status.type !== "idle") throw new Error(`原生会话状态无法核验：${thread.status.type}。`);
				if (typeof thread.canAcceptDirectInput !== "boolean") throw new Error("当前原生版本未提供直接输入能力观测。");
				if (!thread.canAcceptDirectInput) return;
				let latest;
				for (let attempt = 0; attempt < 5; attempt++) {
					latest = (await query("workspace.getState", workspaceId)).sessions[summary.taskId];
					if (latest?.userTurnKind !== "needs_input") break;
					await delay(250);
				}
				if (!latest || latest.runtimeSessionIncarnationId !== summary.runtimeSessionIncarnationId || latest.agentNativeConversationSessionIdentity?.nativeSessionId !== nativeId) throw new Error("核验期间会话身份改变，请重新核验。");
				if (latest.turnOwner !== "user" || latest.userTurnKind !== "review") throw new Error(`原生空闲且可直接输入，运行时仍为 ${latest.userTurnKind ?? latest.turnOwner}。`);
				idleVerified++;
				observations.push({ workspaceId, conversationSessionId: summary.taskId, nativeState: thread.status.type, userTurnKind: latest.userTurnKind });
			} catch (error) { failures.push({ workspaceId, conversationSessionId: summary.taskId, reason: error.message }); }
		}));
	}
	console.log(JSON.stringify({ observedAt: new Date().toISOString(), idleVerified, observations, failures }, null, 2));
	if (failures.length > 0) throw new Error("存在状态误标或无法核验的活体会话，详见上方逐项原因。");
	if (idleVerified === 0) throw new Error("未找到可核验的原生空闲 Codex 会话；请在普通对话 rewind 后重新运行。");
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
