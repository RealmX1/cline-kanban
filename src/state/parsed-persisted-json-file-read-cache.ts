import { stat } from "node:fs/promises";

export interface ParsedPersistedJsonFileReadCache<T> {
	read(path: string, readAndParseCurrentFile: () => Promise<T>): Promise<T>;
	forget(path: string): void;
}

async function readPersistedFileIdentityAndChangeFingerprint(path: string): Promise<string | null> {
	try {
		const file = await stat(path, { bigint: true });
		return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

// 只复用已解析的读取结果。写入方及持锁校验必须绕过此缓存；调用方不得修改返回的对象。
// inode/ctime 纳入指纹，避免同尺寸原子替换或高频写入被仅 mtime/size 的门控漏掉。
export function createParsedPersistedJsonFileReadCache<T>(): ParsedPersistedJsonFileReadCache<T> {
	const cachedFilesByPath = new Map<string, { fingerprint: string; value: T }>();
	const pendingReadsByPath = new Map<string, { fingerprint: string; generation: symbol; promise: Promise<T> }>();

	return {
		async read(path, readAndParseCurrentFile) {
			const before = await readPersistedFileIdentityAndChangeFingerprint(path);
			if (before === null) {
				cachedFilesByPath.delete(path);
				pendingReadsByPath.delete(path);
				return await readAndParseCurrentFile();
			}
			const cached = cachedFilesByPath.get(path);
			if (cached?.fingerprint === before) return cached.value;
			const pending = pendingReadsByPath.get(path);
			if (pending?.fingerprint === before) return await pending.promise;

			const generation = Symbol();
			const promise = (async () => {
				const value = await readAndParseCurrentFile();
				const after = await readPersistedFileIdentityAndChangeFingerprint(path);
				// 文件在读期间变了，或项目已被 forget：返回本次读取结果，但不把它标成当前版本。
				if (before === after && pendingReadsByPath.get(path)?.generation === generation) {
					cachedFilesByPath.set(path, { fingerprint: before, value });
				}
				return value;
			})();
			pendingReadsByPath.set(path, { fingerprint: before, generation, promise });
			try {
				return await promise;
			} finally {
				if (pendingReadsByPath.get(path)?.promise === promise) pendingReadsByPath.delete(path);
			}
		},
		forget(path) {
			cachedFilesByPath.delete(path);
			pendingReadsByPath.delete(path);
		},
	};
}
