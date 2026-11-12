// 只读观察真实运行时的全局快照、后续采样和重连补发，不创建项目或 Agent。
import assert from "node:assert/strict";
import { totalmem } from "node:os";

const configuredHost = process.env.KANBAN_RUNTIME_HOST || "127.0.0.1";
const host = configuredHost === "0.0.0.0" || configuredHost === "::" ? "127.0.0.1" : configuredHost;
const url = new URL(`http://${host.includes(":") ? `[${host}]` : host}:${process.env.KANBAN_RUNTIME_PORT || "3484"}/api/runtime/ws`);
url.protocol = "ws:";
const sockets = new Set();

function openSnapshotReader() {
	const socket = new WebSocket(url);
	sockets.add(socket);
	const snapshots = [];
	let failure = null;
	const listeners = new Set();
	socket.addEventListener("message", ({ data }) => {
		try {
			const message = JSON.parse(String(data));
			if (message.type === "system_load_and_runtime_status_updated") {
				snapshots.push(message.snapshot);
				for (const listener of listeners) listener();
			}
		} catch { /* 非系统状态消息不影响验证。 */ }
	});
	socket.addEventListener("error", () => { failure = new Error("运行实例的 WebSocket 连接失败"); for (const listener of listeners) listener(); });
	return {
		socket,
		waitForSnapshot(predicate, timeoutMs = 12_000) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => finish(new Error("未在期限内收到系统概况；请确认已部署候选版本且状态流可达")), timeoutMs);
				const finish = (error, snapshot) => { clearTimeout(timer); listeners.delete(check); if (error) reject(error); else resolve(snapshot); };
				const check = () => { const found = snapshots.find(predicate); if (failure) finish(failure); else if (found) finish(null, found); };
				listeners.add(check);
				check();
			});
		},
	};
}

try {
	const firstReader = openSnapshotReader();
	const first = await firstReader.waitForSnapshot(() => true);
	const next = await firstReader.waitForSnapshot((snapshot) => snapshot.sampledAtEpochMs > first.sampledAtEpochMs && snapshot.cpuUsagePercent !== null);
	assert.ok(next.cpuUsagePercent >= 0 && next.cpuUsagePercent <= 100, "CPU 超出整机容量范围");
	assert.equal(next.memory?.totalBytes, totalmem(), "内存总量与运行脚本所在宿主机不符");
	assert.ok(next.memory.usedBytes >= 0 && next.memory.usedBytes <= next.memory.totalBytes, "内存数据无效");
	assert.ok(next.disk?.availableBytes >= 0 && next.disk.availableBytes <= next.disk.totalBytes, "数据目录所在磁盘空间不可用");
	assert.ok(Number.isInteger(next.liveAgentSessionCount) && next.liveAgentSessionCount >= 0, "活跃 Agent 会话数无效");
	assert.ok(next.runtimeUptimeSeconds >= 0, "运行时长无效");
	firstReader.socket.close();
	const reconnected = openSnapshotReader();
	const replay = await reconnected.waitForSnapshot(() => true);
	assert.ok(replay.sampledAtEpochMs >= next.sampledAtEpochMs, "重连补发了更旧的样本");
	console.log("通过：真实运行时持续推送宿主机负载，重连后可读取缓存快照。");
} catch (error) {
	console.error(`部署后验证未通过：${error.message}`);
	process.exitCode = 1;
} finally {
	for (const socket of sockets) socket.close();
}
