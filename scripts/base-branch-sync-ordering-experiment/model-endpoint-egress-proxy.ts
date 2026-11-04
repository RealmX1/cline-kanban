import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { appendFile } from "node:fs/promises";
import { createServer, type OutgoingHttpHeaders, request } from "node:http";
import { BlockList, connect, type Socket } from "node:net";
import { join } from "node:path";
import { z } from "zod";

export const approvedModelEndpointSchema = z.object({
	hostname: z
		.string()
		.min(1)
		.transform((hostname) => hostname.toLowerCase().replace(/^\[|\]$/gu, "")),
	port: z
		.number()
		.int()
		.min(1)
		.max(65535)
		.refine((port) => (port === 80 || port === 443 || port >= 1024) && port !== 3484),
});
export type ApprovedModelEndpoint = z.infer<typeof approvedModelEndpointSchema>;

export function requireApprovedModelProxyTarget(authority: string, endpoints: ApprovedModelEndpoint[]) {
	const destination = new URL(`http://${authority}`);
	const hostname = destination.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
	const port = Number(destination.port || 80);
	if (
		authority.toLowerCase() !== `${destination.hostname.toLowerCase()}:${port}` ||
		!endpoints.some((endpoint) => endpoint.hostname === hostname && endpoint.port === port)
	)
		throw new Error("目标不在冻结的模型端点白名单中");
	return { hostname, port };
}

const prohibitedModelAddresses = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
	["224.0.0.0", 4],
	["240.0.0.0", 4],
] as const)
	prohibitedModelAddresses.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
	["::", 128],
	["::1", 128],
	["fc00::", 7],
	["fe80::", 10],
	["ff00::", 8],
] as const)
	prohibitedModelAddresses.addSubnet(address, prefix, "ipv6");

/** Seatbelt 只接受 localhost 或通配主机；专用代理负责精确主机校验并固定实际连接地址。 */
export async function startModelEndpointEgressProxy(
	endpoints: ApprovedModelEndpoint[],
	evidenceDirectory: string,
	dependencies: {
		lookup?: typeof lookup;
		createServer?: typeof createServer;
		connect?: typeof connect;
		request?: typeof request;
	} = {},
) {
	const approvedEndpoints = z.array(approvedModelEndpointSchema).min(1).parse(endpoints);
	const sockets = new Set<Socket>();
	const track = (socket: Socket) => {
		sockets.add(socket);
		socket.on("error", () => socket.destroy());
		socket.once("close", () => sockets.delete(socket));
		return socket;
	};
	const resolveTarget = async (authority: string) => {
		const endpoint = requireApprovedModelProxyTarget(authority, approvedEndpoints);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let addresses: LookupAddress[];
		try {
			addresses = await Promise.race([
				(dependencies.lookup ?? lookup)(endpoint.hostname, { all: true }),
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(() => reject(new Error("模型端点解析达到固定截止时间")), 10_000);
				}),
			]);
		} finally {
			clearTimeout(timeout);
		}
		// 多地址解析只选择允许的地址；不向禁止地址回退。
		const permittedAddresses = addresses.filter(
			({ address, family }) => !prohibitedModelAddresses.check(address, family === 6 ? "ipv6" : "ipv4"),
		);
		if (!permittedAddresses.length) throw new Error("模型端点解析到了本地、私有或不可路由地址");
		return { ...endpoint, address: permittedAddresses[0].address };
	};
	const record = async (authority: string, outcome: string) =>
		appendFile(
			join(evidenceDirectory, "model-endpoint-egress-observations.jsonl"),
			`${JSON.stringify({ observedAt: Date.now(), authority, outcome })}\n`,
			{ mode: 0o600 },
		);
	const server = (dependencies.createServer ?? createServer)(async (incoming, response) => {
		try {
			const destination = new URL(incoming.url ?? "");
			if (destination.protocol !== "http:" || destination.username || destination.password)
				throw new Error("代理只接受模型 HTTP 请求或 TLS CONNECT");
			const authority = `${destination.hostname}:${destination.port || 80}`;
			const target = await resolveTarget(authority);
			await record(authority, "approved-http-model-request");
			if (incoming.destroyed) return;
			const headers: OutgoingHttpHeaders = { ...incoming.headers, host: destination.host };
			delete headers["proxy-authorization"];
			delete headers["proxy-connection"];
			const upstream = (dependencies.request ?? request)(
				{
					hostname: target.address,
					port: target.port,
					method: incoming.method,
					path: `${destination.pathname}${destination.search}`,
					headers,
				},
				(reply) => {
					response.writeHead(reply.statusCode ?? 502, reply.headers);
					reply.pipe(response);
				},
			);
			upstream.on("socket", track);
			upstream.on("error", () => response.destroy());
			incoming.on("aborted", () => upstream.destroy());
			incoming.pipe(upstream);
		} catch {
			response.writeHead(403).end();
		}
	});
	server.on("connection", track);
	server.on("connect", async (incoming, client, head) => {
		const authority = incoming.url ?? "";
		try {
			const target = await resolveTarget(authority);
			await record(authority, "approved-tls-model-tunnel");
			if (client.destroyed) return;
			const upstream = track((dependencies.connect ?? connect)({ host: target.address, port: target.port }));
			upstream.setTimeout(10_000, () => upstream.destroy());
			upstream.once("connect", () => {
				upstream.setTimeout(0);
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				if (head.length) upstream.write(head);
				client.pipe(upstream).pipe(client);
			});
			upstream.on("error", () => client.destroy());
			client.on("error", () => upstream.destroy());
			client.once("close", () => upstream.destroy());
			upstream.once("close", () => client.destroy());
		} catch {
			client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
		}
	});
	await new Promise<void>((resolveListening, reject) => {
		server.once("error", reject);
		server.once("listening", resolveListening);
		server.listen(0, "127.0.0.1");
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("模型代理没有取得专用端口");
	return {
		port: address.port,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolveClose, reject) =>
				server.close((error) => (error ? reject(error) : resolveClose())),
			);
		},
	};
}
