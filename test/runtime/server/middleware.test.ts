import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
	getKanbanRuntimeHost,
	getKanbanRuntimePort,
	parseKanbanAdditionalTrustedBrowserOrigin,
	setKanbanAdditionalTrustedBrowserOrigins,
	setKanbanRuntimeHost,
	setKanbanRuntimePort,
} from "../../../src/core/runtime-endpoint";
import {
	evaluateCors,
	evaluateHost,
	getAllowedBrowserOrigins,
	getAllowedHostHeaders,
	handleSocketUpgrade,
} from "../../../src/server/middleware";

const ALLOWED_ORIGIN = "http://127.0.0.1:3484";
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([ALLOWED_ORIGIN]);
const ALLOWED_HOSTS = new Set(["localhost:3484", "127.0.0.1:3484"]);

function makeFakeRequest(headers: Partial<IncomingMessage["headers"]>, method = "GET"): IncomingMessage {
	return { method, headers } as IncomingMessage;
}

describe("evaluateCors", () => {
	it("allows requests with no Origin header", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: undefined,
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "allow", origin: null });
	});

	it("allows requests with an empty Origin header", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: "",
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "allow", origin: null });
	});

	it("allows requests whose Origin matches the runtime origin", () => {
		const decision = evaluateCors({
			method: "POST",
			originHeader: ALLOWED_ORIGIN,
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "allow", origin: ALLOWED_ORIGIN });
	});

	it("rejects requests from a different origin", () => {
		const decision = evaluateCors({
			method: "POST",
			originHeader: "http://evil.example.com",
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "reject", origin: "http://evil.example.com" });
	});

	it("rejects requests from the same host but a different port", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: "http://127.0.0.1:9999",
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "reject", origin: "http://127.0.0.1:9999" });
	});

	it("rejects requests from the same host but a different scheme", () => {
		const decision = evaluateCors({
			method: "GET",
			originHeader: "https://127.0.0.1:3484",
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "reject", origin: "https://127.0.0.1:3484" });
	});

	it("returns a preflight decision for OPTIONS from the allowed origin", () => {
		const decision = evaluateCors({
			method: "OPTIONS",
			originHeader: ALLOWED_ORIGIN,
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "preflight", origin: ALLOWED_ORIGIN });
	});

	it("rejects preflight from a disallowed origin", () => {
		const decision = evaluateCors({
			method: "OPTIONS",
			originHeader: "http://evil.example.com",
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "reject", origin: "http://evil.example.com" });
	});

	it("allows OPTIONS without an Origin header (not a CORS preflight)", () => {
		const decision = evaluateCors({
			method: "OPTIONS",
			originHeader: undefined,
			allowedOrigins: ALLOWED_ORIGINS,
		});
		expect(decision).toEqual({ kind: "allow", origin: null });
	});
});

describe("evaluateHost", () => {
	it("rejects requests with no Host header", () => {
		expect(evaluateHost({ hostHeader: undefined, allowedHosts: ALLOWED_HOSTS })).toEqual({
			kind: "reject",
			host: null,
		});
	});

	it("rejects requests with an empty Host header", () => {
		expect(evaluateHost({ hostHeader: "", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "reject", host: null });
	});

	it("allows requests whose Host is in the allowlist", () => {
		expect(evaluateHost({ hostHeader: "127.0.0.1:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "allow" });
		expect(evaluateHost({ hostHeader: "localhost:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "allow" });
	});

	it("normalises Host header casing before comparing", () => {
		expect(evaluateHost({ hostHeader: "LocalHost:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({ kind: "allow" });
	});

	it("rejects DNS rebinding attempts via a foreign Host header", () => {
		expect(evaluateHost({ hostHeader: "attacker.example.com:3484", allowedHosts: ALLOWED_HOSTS })).toEqual({
			kind: "reject",
			host: "attacker.example.com:3484",
		});
	});

	it("rejects when the port doesn't match", () => {
		expect(evaluateHost({ hostHeader: "localhost:9999", allowedHosts: ALLOWED_HOSTS })).toEqual({
			kind: "reject",
			host: "localhost:9999",
		});
	});
});

describe("handleSocketUpgrade", () => {
	it("passes through upgrades whose Host and Origin are both allowed", () => {
		const socket = new PassThrough();
		const request = makeFakeRequest({ host: "127.0.0.1:3484", origin: ALLOWED_ORIGIN });
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: false });
		expect(socket.destroyed).toBe(false);
	});

	it("rejects upgrades from a disallowed origin with a 403 status line", () => {
		const socket = new PassThrough();
		const written: Buffer[] = [];
		socket.on("data", (chunk) => {
			written.push(chunk as Buffer);
		});
		const request = makeFakeRequest({ host: "127.0.0.1:3484", origin: "http://evil.example.com" });
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: true });
		expect(socket.destroyed).toBe(true);
		expect(Buffer.concat(written).toString("utf8")).toContain("HTTP/1.1 403 Forbidden");
	});

	it("rejects upgrades whose Host header doesn't match the allowlist", () => {
		const socket = new PassThrough();
		const request = makeFakeRequest({ host: "attacker.example.com:3484", origin: ALLOWED_ORIGIN });
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: true });
		expect(socket.destroyed).toBe(true);
	});

	it("rejects upgrades with a missing Host header", () => {
		const socket = new PassThrough();
		const request = makeFakeRequest({});
		const result = handleSocketUpgrade(request, socket);
		expect(result).toEqual({ end: true });
		expect(socket.destroyed).toBe(true);
	});
});

describe("additional trusted browser origins (reverse proxy such as tailscale serve)", () => {
	const originalRuntimeHost = getKanbanRuntimeHost();
	const originalRuntimePort = getKanbanRuntimePort();
	const originalEnvHost = process.env.KANBAN_RUNTIME_HOST;
	const originalEnvPort = process.env.KANBAN_RUNTIME_PORT;
	const TAILSCALE_SERVE_ORIGIN = "https://my-machine.example-tailnet.ts.net:3485";

	afterEach(() => {
		setKanbanAdditionalTrustedBrowserOrigins([]);
		// 两个 setter 会顺带写 process.env，恢复模块状态后还要把 env 还原成进来时的样子。
		setKanbanRuntimeHost(originalRuntimeHost);
		setKanbanRuntimePort(originalRuntimePort);
		if (originalEnvHost === undefined) {
			delete process.env.KANBAN_RUNTIME_HOST;
		} else {
			process.env.KANBAN_RUNTIME_HOST = originalEnvHost;
		}
		if (originalEnvPort === undefined) {
			delete process.env.KANBAN_RUNTIME_PORT;
		} else {
			process.env.KANBAN_RUNTIME_PORT = originalEnvPort;
		}
	});

	it("normalises a configured origin into the Origin and Host header spellings browsers send", () => {
		expect(parseKanbanAdditionalTrustedBrowserOrigin("https://My-Machine.example-tailnet.ts.net:3485/")).toEqual({
			browserOrigin: "https://my-machine.example-tailnet.ts.net:3485",
			hostHeaderValue: "my-machine.example-tailnet.ts.net:3485",
		});
		// 默认端口时浏览器的 Host 头不带端口。
		expect(parseKanbanAdditionalTrustedBrowserOrigin("https://my-machine.example-tailnet.ts.net:443")).toEqual({
			browserOrigin: "https://my-machine.example-tailnet.ts.net",
			hostHeaderValue: "my-machine.example-tailnet.ts.net",
		});
	});

	it("rejects values that are not a bare http(s) origin", () => {
		for (const invalid of [
			"my-machine.example-tailnet.ts.net:3485",
			"ftp://my-machine.example-tailnet.ts.net",
			"https://my-machine.example-tailnet.ts.net:3485/kanban",
			"https://my-machine.example-tailnet.ts.net:3485/?x=1",
			"https://user:pass@my-machine.example-tailnet.ts.net:3485",
		]) {
			expect(() => parseKanbanAdditionalTrustedBrowserOrigin(invalid)).toThrow(
				/Invalid --additional-trusted-browser-origin/,
			);
		}
	});

	it("keeps the allowlists unchanged when nothing is configured", () => {
		setKanbanRuntimeHost("127.0.0.1");
		setKanbanRuntimePort(3484);
		expect([...getAllowedBrowserOrigins()]).toEqual(["http://127.0.0.1:3484"]);
		expect([...getAllowedHostHeaders()].sort()).toEqual(["127.0.0.1:3484", "localhost:3484"]);
	});

	it("allows HTTP requests and WebSocket upgrades arriving through the configured origin", () => {
		setKanbanRuntimeHost("127.0.0.1");
		setKanbanRuntimePort(3484);
		setKanbanAdditionalTrustedBrowserOrigins([TAILSCALE_SERVE_ORIGIN]);

		expect(getAllowedBrowserOrigins().has(TAILSCALE_SERVE_ORIGIN)).toBe(true);
		expect(getAllowedBrowserOrigins().has(ALLOWED_ORIGIN)).toBe(true);
		expect(getAllowedHostHeaders().has("my-machine.example-tailnet.ts.net:3485")).toBe(true);

		const socket = new PassThrough();
		const request = makeFakeRequest({
			host: "my-machine.example-tailnet.ts.net:3485",
			origin: TAILSCALE_SERVE_ORIGIN,
		});
		expect(handleSocketUpgrade(request, socket)).toEqual({ end: false });
		expect(socket.destroyed).toBe(false);
	});

	it("still rejects unrelated origins and hosts when an extra origin is configured", () => {
		setKanbanRuntimeHost("127.0.0.1");
		setKanbanRuntimePort(3484);
		setKanbanAdditionalTrustedBrowserOrigins([TAILSCALE_SERVE_ORIGIN]);

		const foreignOriginSocket = new PassThrough();
		expect(
			handleSocketUpgrade(
				makeFakeRequest({ host: "my-machine.example-tailnet.ts.net:3485", origin: "https://evil.example.com" }),
				foreignOriginSocket,
			),
		).toEqual({ end: true });

		// 同主机名、不同 scheme：http 页面不是受信 origin。
		const downgradedSchemeSocket = new PassThrough();
		expect(
			handleSocketUpgrade(
				makeFakeRequest({
					host: "my-machine.example-tailnet.ts.net:3485",
					origin: "http://my-machine.example-tailnet.ts.net:3485",
				}),
				downgradedSchemeSocket,
			),
		).toEqual({ end: true });

		const foreignHostSocket = new PassThrough();
		expect(
			handleSocketUpgrade(
				makeFakeRequest({ host: "attacker.example.com:3485", origin: TAILSCALE_SERVE_ORIGIN }),
				foreignHostSocket,
			),
		).toEqual({ end: true });
	});

	it("also accepts the proxied Host in remote-bind mode", () => {
		setKanbanRuntimeHost("100.64.0.1");
		setKanbanRuntimePort(3484);
		setKanbanAdditionalTrustedBrowserOrigins([TAILSCALE_SERVE_ORIGIN]);
		expect([...getAllowedHostHeaders()].sort()).toEqual([
			"100.64.0.1:3484",
			"my-machine.example-tailnet.ts.net:3485",
		]);
	});
});
