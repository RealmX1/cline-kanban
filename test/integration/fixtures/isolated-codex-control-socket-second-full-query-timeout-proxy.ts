import { once } from "node:events";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";

// 只包住隔离 runtime 自己创建的原生 socket：真实转发全部请求，第二次完整回合查询仅丢弃响应。
// 这样真实客户端会经历自己的 2 秒超时，后续查询和 turn/start 仍由真实 Codex 处理。
export async function startIsolatedCodexSecondFullQueryTimeoutProxy(
	socketPath: string,
	nativeSessionId: string,
	queueStatePath: string,
) {
	const upstreamSocketPath = `${socketPath}-upstream`;
	renameSync(socketPath, upstreamSocketPath);
	const httpServer = createServer();
	const websocketServer = new WebSocketServer({ server: httpServer });
	const connections = new Set<WebSocket>();
	const observations = { fullTurnQueryCount: 0, injectedTimeoutCount: 0, turnStartCount: 0 };
	websocketServer.on("connection", (downstream) => {
		const upstream = new WebSocket(`ws+unix://${upstreamSocketPath}:/`);
		connections.add(downstream);
		connections.add(upstream);
		const pending: { bytes: WebSocket.RawData; isBinary: boolean }[] = [];
		let droppedResponseId: unknown;
		upstream.on("open", () => {
			for (const { bytes, isBinary } of pending) upstream.send(bytes, { binary: isBinary });
			pending.length = 0;
		});
		downstream.on("message", (bytes, isBinary) => {
			try {
				const request = JSON.parse(bytes.toString());
				if (request.method === "turn/start" && request.params?.threadId === nativeSessionId)
					observations.turnStartCount += 1;
				if (
					request.method === "thread/turns/list" &&
					request.params?.threadId === nativeSessionId &&
					request.params?.itemsView === "full" &&
					request.params?.sortDirection === "asc" &&
					request.params?.limit === 100
				) {
					observations.fullTurnQueryCount += 1;
					const snapshot = JSON.parse(readFileSync(queueStatePath, "utf8"));
					const beforeSubmission = Object.values(
						snapshot.entriesByTaskId as Record<
							string,
							{
								deliveryState: string;
								requiredNativeIndependentUserTurnSessionId?: string;
								nativeIndependentUserTurnSubmissionProgress?: {
									submissionMayHaveStartedAtEpochMs: number | null;
								};
							}[]
						>,
					)
						.flat()
						.some(
							(entry) =>
								entry.deliveryState === "handed_to_transport" &&
								entry.requiredNativeIndependentUserTurnSessionId === nativeSessionId &&
								entry.nativeIndependentUserTurnSubmissionProgress?.submissionMayHaveStartedAtEpochMs === null,
						);
					if (observations.injectedTimeoutCount === 0 && beforeSubmission) {
						droppedResponseId = request.id;
						observations.injectedTimeoutCount += 1;
					}
				}
			} catch {
				/* 非 JSON 帧照常转发。 */
			}
			if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes, { binary: isBinary });
			else if (upstream.readyState === WebSocket.CONNECTING) pending.push({ bytes, isBinary });
		});
		upstream.on("message", (bytes, isBinary) => {
			try {
				const response = JSON.parse(bytes.toString());
				if (droppedResponseId !== undefined && response.id === droppedResponseId) return;
			} catch {
				/* 非 JSON 帧照常转发。 */
			}
			if (downstream.readyState === WebSocket.OPEN) downstream.send(bytes, { binary: isBinary });
		});
		let pairClosed = false;
		const closePair = () => {
			if (pairClosed) return;
			pairClosed = true;
			connections.delete(downstream);
			connections.delete(upstream);
			downstream.terminate();
			upstream.terminate();
		};
		downstream.on("error", closePair);
		upstream.on("error", closePair);
		downstream.on("close", closePair);
		upstream.on("close", closePair);
	});
	try {
		httpServer.listen(socketPath);
		await once(httpServer, "listening");
	} catch (error) {
		if (existsSync(upstreamSocketPath)) renameSync(upstreamSocketPath, socketPath);
		throw error;
	}
	return {
		observations,
		async stop() {
			for (const connection of connections) connection.terminate();
			await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
			if (existsSync(upstreamSocketPath)) renameSync(upstreamSocketPath, socketPath);
		},
	};
}
