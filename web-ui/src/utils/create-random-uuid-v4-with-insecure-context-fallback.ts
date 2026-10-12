/**
 * 生成 RFC 4122 v4 UUID。
 *
 * 存在理由：`crypto.randomUUID` 只在 secure context（https 或 localhost）里存在，经
 * `http://<局域网 / tailnet 地址>` 访问时直接调用会抛 TypeError。`crypto.getRandomValues` 没有这个
 * 限制，所以降级时用它拼出同样格式、同样随机强度的 UUID，而不是退回 `Math.random`。
 */
export function createRandomUuidV4WithInsecureContextFallback(): string {
	if (typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	// 版本位 0100（v4）与变体位 10xx。
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
