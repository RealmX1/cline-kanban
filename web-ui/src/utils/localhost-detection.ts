const LOCALHOST_HOSTS = ["localhost", "127.0.0.1", "::1"];

/**
 * 去掉 IPv6 字面量主机名外层的方括号。
 *
 * 浏览器访问 `http://[::1]:3484` 时，`window.location.hostname` 给出的是带方括号的 `[::1]`
 * （WHATWG URL 规范如此），直接和不带方括号的 `::1` 比较会把本机误判成远程。
 */
export function stripSquareBracketsFromIpv6LiteralHostname(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Returns true when the browser is accessing Kanban from the same machine
 * where it is hosted (i.e. via localhost, 127.0.0.1, or the IPv6 loopback).
 *
 * This is a best-effort heuristic — it won't catch cases where a user accesses
 * the server via a LAN hostname from the same machine, but that's acceptable.
 */
export function isLocalhostAccess(): boolean {
	if (typeof window === "undefined") {
		return false;
	}
	return LOCALHOST_HOSTS.includes(stripSquareBracketsFromIpv6LiteralHostname(window.location.hostname));
}
