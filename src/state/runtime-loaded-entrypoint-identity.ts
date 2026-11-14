import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// 只在模块载入时取证，发布后不能重新读取磁盘冒充正在运行的代码。
export const RUNTIME_LOADED_ENTRYPOINT_SHA256: string | null = (() => {
	const entrypoint = process.argv[1];
	if (!entrypoint) return null;
	try {
		return createHash("sha256").update(readFileSync(entrypoint)).digest("hex");
	} catch {
		return null;
	}
})();
