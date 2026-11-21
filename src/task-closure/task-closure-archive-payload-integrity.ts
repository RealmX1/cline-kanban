import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export async function fingerprintTaskClosureArchivePayload(archiveDirectory: string) {
	const digest = createHash("sha256");
	let bytes = 0;
	async function inspect(path: string) {
		const info = await lstat(path);
		if (info.isDirectory() && !info.isSymbolicLink()) {
			for (const name of (await readdir(path)).sort()) await inspect(join(path, name));
		} else if (info.isFile()) {
			digest.update(JSON.stringify([relative(archiveDirectory, path), info.mode, info.size]));
			for await (const chunk of createReadStream(path)) {
				digest.update(chunk);
				bytes += Buffer.byteLength(chunk);
			}
		} else throw new Error("归档载荷包含符号链接或特殊文件，无法证明完整性。");
	}
	await inspect(archiveDirectory);
	return { archivePayloadIntegritySha256: digest.digest("hex"), archivePayloadSizeBytes: bytes };
}
