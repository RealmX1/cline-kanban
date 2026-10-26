import { lstat, mkdir, open, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { configurationDigest } from "./codex-configuration-field-projection";
import { getCodexConfigurationSyncDirectory } from "./codex-configuration-sync-store";

// 与既有 RVF 不可变快照并存：正文、references 和 helpers 使用同一内容寻址闭包，旧阶段不被清理。
export async function captureCodexConfigurationExecutionClosure(skillFilePath: string) {
	const physicalSkillPath = await realpath(skillFilePath);
	let root = dirname(physicalSkillPath);
	for (let parent = root, depth = 0; depth < 4; depth++, parent = dirname(parent)) {
		try {
			if ((await lstat(join(parent, ".claude-plugin", "plugin.json"))).isFile()) {
				root = parent;
				break;
			}
		} catch {
			/* 非插件 skill 以自己的目录为闭包边界。 */
		}
	}
	const files: Array<{ path: string; bytes: Buffer; mode: number }> = [];
	let byteLength = 0;
	const collect = async (directory: string, ancestors: Set<string>) => {
		const physicalDirectory = await realpath(directory);
		if (ancestors.has(physicalDirectory)) throw new Error("Skill 执行闭包包含循环软链。");
		const nextAncestors = new Set([...ancestors, physicalDirectory]);
		for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			if ([".git", "node_modules", ".DS_Store", "__pycache__"].includes(entry.name)) continue;
			const path = join(directory, entry.name);
			const physicalPath = await realpath(path);
			const before = await lstat(physicalPath);
			if (before.isDirectory()) {
				await collect(path, nextAncestors);
				continue;
			}
			if (!before.isFile()) throw new Error("Skill 执行闭包包含非普通文件。");
			if (files.length >= 4_000 || before.size > 64 * 1024 * 1024 - byteLength)
				throw new Error("Skill 执行闭包超过有界采集预算。");
			const sourceFile = await open(physicalPath, "r");
			let bytes: Buffer;
			try {
				bytes = Buffer.alloc(before.size);
				let readByteLength = 0;
				while (readByteLength < bytes.length) {
					const { bytesRead } = await sourceFile.read(
						bytes,
						readByteLength,
						bytes.length - readByteLength,
						readByteLength,
					);
					if (bytesRead === 0) throw new Error("Skill 执行闭包采集时发生变化。");
					readByteLength += bytesRead;
				}
				// 只多读一个字节探测增长，避免文件在 stat 之后变大时突破读取预算。
				if ((await sourceFile.read(Buffer.alloc(1), 0, 1, before.size)).bytesRead !== 0)
					throw new Error("Skill 执行闭包采集时发生变化。");
			} finally {
				await sourceFile.close();
			}
			const after = await lstat(physicalPath);
			if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size)
				throw new Error("Skill 执行闭包采集时发生变化。");
			byteLength += bytes.length;
			files.push({ path: relative(root, path), bytes, mode: before.mode & 0o111 ? 0o700 : 0o600 });
		}
	};
	await collect(root, new Set());
	const manifest = files.map((file) => ({
		path: file.path,
		sha256: configurationDigest(file.bytes.toString("base64")),
		mode: file.mode,
	}));
	const sha256 = configurationDigest(manifest);
	const directoryPath = join(getCodexConfigurationSyncDirectory(), "immutable-execution-closures", sha256);
	await mkdir(directoryPath, { recursive: true, mode: 0o700 });
	for (const file of files) {
		const destination = join(directoryPath, file.path);
		await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
		try {
			await writeFile(destination, file.bytes, { mode: file.mode, flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await readFile(destination)).equals(file.bytes))
				throw error;
		}
	}
	const manifestText = JSON.stringify({ sourceRoot: root, files: manifest });
	try {
		await writeFile(join(directoryPath, "execution-closure-manifest.json"), manifestText, {
			flag: "wx",
			mode: 0o600,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	return {
		sha256,
		directoryPath,
		skillFilePath: join(directoryPath, relative(root, physicalSkillPath)),
		fileCount: files.length,
	};
}

export async function verifyCodexConfigurationExecutionClosure(reference: {
	sha256: string;
	directoryPath: string;
	skillFilePath: string;
	fileCount: number;
}) {
	const expectedDirectory = join(
		getCodexConfigurationSyncDirectory(),
		"immutable-execution-closures",
		reference.sha256,
	);
	if ((await realpath(reference.directoryPath)) !== (await realpath(expectedDirectory)))
		throw new Error("执行闭包目录归属不符。");
	const manifest = z
		.object({ files: z.array(z.object({ path: z.string(), sha256: z.string(), mode: z.number() })) })
		.parse(JSON.parse(await readFile(join(reference.directoryPath, "execution-closure-manifest.json"), "utf8")));
	if (configurationDigest(manifest.files) !== reference.sha256 || manifest.files.length !== reference.fileCount)
		throw new Error("执行闭包清单摘要不符。");
	for (const file of manifest.files) {
		if (isAbsolute(file.path) || file.path.split(/[\\/]/).includes("..")) throw new Error("执行闭包包含越界路径。");
		const path = join(reference.directoryPath, file.path);
		if (
			!(await lstat(path)).isFile() ||
			configurationDigest((await readFile(path)).toString("base64")) !== file.sha256
		)
			throw new Error("执行闭包文件摘要不符。");
	}
	const skillRelativePath = relative(reference.directoryPath, reference.skillFilePath);
	if (!manifest.files.some((file) => file.path === skillRelativePath))
		throw new Error("阶段 Skill 不属于已保存的执行闭包。");
	return reference.skillFilePath;
}
