#!/usr/bin/env node
// 只提供本测试的 Unix WebSocket 与确定性事件，不调用模型或 shell。
const http = require("node:http");
const { WebSocketServer } = require(process.env.KANBAN_COMPARISON_TEST_WS_MODULE_PATH);
const server = http.createServer();
const sockets = new WebSocketServer({ server });
const socketPath = process.argv[process.argv.indexOf("--listen") + 1].replace("unix://", "");
sockets.on("connection", (socket) => {
	let currentTurnId = null;
	let nativeSessionId = "native-test-thread";
	let forkCreated = false;
	socket.on("message", (bytes) => {
		const request = JSON.parse(bytes.toString());
		if (!request.method || request.id === undefined) return;
		const reply = (result) => socket.send(JSON.stringify({ id: request.id, result }));
		const notify = (method, params) => socket.send(JSON.stringify({ method, params: { threadId: nativeSessionId, ...params } }));
		if (request.method === "initialize") reply({});
		else if (request.method === "thread/list") reply({ data: [{ id: "native-test-thread", forkedFromId: null, cwd: process.cwd() }, ...(forkCreated ? [{ id: "forked-test-thread", forkedFromId: "native-test-thread", cwd: process.cwd(), path: `${process.cwd()}/forked.jsonl` }] : [])], nextCursor: null });
		else if (request.method === "thread/read") reply({ thread: { id: request.params.threadId, forkedFromId: request.params.threadId === "forked-test-thread" ? "native-test-thread" : null, cwd: process.cwd(), path: `${process.cwd()}/forked.jsonl` } });
		else if (["thread/start", "thread/resume"].includes(request.method)) {
			nativeSessionId = request.params.threadId ?? "native-test-thread";
			reply({ thread: { id: nativeSessionId, cwd: process.cwd() }, model: "fixture-model" });
		}
		else if (request.method === "thread/turns/list") {
			const history = [{ id: "historical-turn", status: "completed", items: [{ id: "historical-user", type: "userMessage", content: [{ type: "text", text: "历史输入" }] }, { id: "historical-assistant", type: "agentMessage", text: "历史输出" }] }];
			if (process.env.KANBAN_COMPARISON_TEST_FORK_PREFIX_INVALID === "1") {
				if (request.params.threadId === "forked-test-thread") history[0].id = "unexpected-prefix";
				else history.push({ id: "removed-boundary-turn", status: "completed", items: [] });
			}
			if (process.env.KANBAN_COMPARISON_TEST_FORK_PREFIX_VALID === "1" && request.params.threadId !== "forked-test-thread") history.push({ id: "removed-boundary-turn", status: "completed", items: [] });
			reply({ data: history, nextCursor: null });
		} else if (request.method === "thread/loaded/list") reply({ data: [...new Set([nativeSessionId, ...((forkCreated && process.env.KANBAN_COMPARISON_TEST_FORK_RESULT_WITHHELD !== "1") || process.env.KANBAN_COMPARISON_TEST_DISCOVER_EXISTING_FORK === "1" ? ["forked-test-thread"] : [])])], nextCursor: null });
		else if (request.method === "thread/fork") {
			forkCreated = true;
			if (process.env.KANBAN_COMPARISON_TEST_FORK_RESPONSE_LOST === "1") socket.send(JSON.stringify({ id: request.id, error: { message: "模拟 fork 已创建但响应丢失" } }));
			else reply({ thread: { id: "forked-test-thread", cwd: process.cwd(), path: `${process.cwd()}/forked.jsonl` } });
		}
		else if (request.method === "turn/start") {
			currentTurnId = "new-test-turn";
			if (request.params.input[0]?.text === "invalid_turn_start_response") { reply({ turn: { id: 3 } }); return; }
			reply({ turn: { id: currentTurnId } });
			const text = request.params.input[0]?.text;
			notify("item/started", { item: { id: "native-user-item", type: "userMessage", content: [{ type: "text", text }] } });
			if (text !== "wait_for_interrupt") {
				notify("item/agentMessage/delta", { itemId: "assistant-item", delta: "中文完整输出" });
				notify("turn/completed", { turn: { id: currentTurnId, status: "completed" } });
			}
		} else if (request.method === "turn/interrupt") {
			reply({}); notify("turn/completed", { turn: { id: currentTurnId, status: "interrupted" } });
		} else socket.send(JSON.stringify({ id: request.id, error: { message: "测试不支持该方法" } }));
	});
});
server.listen(socketPath);
