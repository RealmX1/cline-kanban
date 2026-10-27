import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { getRuntimeHomePath } from "../state/runtime-home-path";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const evidenceSchema = z.object({
	schemaVersion: z.literal(1),
	identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
	physicalDirectoryPath: z.string(),
	volumeUuid: z.string().uuid(),
	inode: z.string(),
	birthtimeNanoseconds: z.string(),
	observedDeviceNumber: z.string(),
	previousDeviceNumber: z.string(),
	boundAtMs: z.number(),
	observedAtMs: z.number(),
	evidenceKind: z.enum(["original_device_identity_matched", "legacy_macos_device_number_changed"]),
	legacyBindingManifestPath: z.string().optional(),
});
type DirectoryIdentityEvidence = z.infer<typeof evidenceSchema>;
const verifiedMountObservationSchema = evidenceSchema.omit({ evidenceKind: true }).extend({
	evidenceKind: z.literal("verified_current_macos_mount"),
	bootSessionUuid: z.string().uuid(),
	filesystemDeviceNodePath: z.string(),
	filesystemDeviceNodeInode: z.string(),
	filesystemDeviceNodeChangedAtNanoseconds: z.string(),
	filesystemDeviceNodeNumber: z.string(),
});
type VerifiedMountObservation = z.infer<typeof verifiedMountObservationSchema>;
export interface CodexDirectoryIdentityExpectation {
	expectedIdentity: string;
	boundAtMs?: number;
	legacyBindingManifestPath?: string;
}

// st_dev 是本次挂载的设备号。持久核验使用卷 UUID；缓存仅减少同一设备的系统查询。
const macosVolumeUuidCache = new Map<
	string,
	{ uuid: string; expiresAtMs: number; filesystemDeviceNodePath: string; filesystemDeviceNodeFingerprint: string }
>();
const macosVolumeUuidQueries = new Map<string, Promise<void>>();
const macosVolumeUuidRetryAfterMs = new Map<string, number>();
const codexDirectoryVolumeSystemQueriesDisabled = new AsyncLocalStorage<boolean>();
let macosBootSessionUuid: string | undefined;
let macosBootSessionQuery: Promise<void> | undefined;
let macosBootSessionRetryAfterMs = 0;
function readMacosFilesystemDeviceNodeFingerprint(path: string, expectedDeviceNumber: string) {
	try {
		const metadata = lstatSync(path, { bigint: true });
		return metadata.isBlockDevice() && `${metadata.rdev}` === expectedDeviceNumber
			? digest([`${metadata.rdev}`, `${metadata.ino}`, `${metadata.ctimeNs}`])
			: undefined;
	} catch {
		return undefined;
	}
}
const executeMacosVolumeQuery = (binary: string, arguments_: string[]) =>
	new Promise<string>((resolve, reject) => {
		execFile(binary, arguments_, { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
async function observeMacosBootSessionUuid() {
	if (macosBootSessionUuid || macosBootSessionRetryAfterMs > Date.now()) return;
	if (macosBootSessionQuery) return macosBootSessionQuery;
	macosBootSessionQuery = executeMacosVolumeQuery("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])
		.then((output) => {
			macosBootSessionUuid = z.string().uuid().parse(output.trim());
		})
		.catch(() => {
			macosBootSessionRetryAfterMs = Date.now() + 5_000;
		})
		.finally(() => {
			macosBootSessionQuery = undefined;
		});
	return macosBootSessionQuery;
}
async function observeMacosVolumeUuid(physicalPath: string, device: string) {
	const cached = macosVolumeUuidCache.get(device);
	if (
		cached &&
		cached.expiresAtMs > Date.now() &&
		cached.filesystemDeviceNodeFingerprint ===
			readMacosFilesystemDeviceNodeFingerprint(cached.filesystemDeviceNodePath, device)
	)
		return;
	if ((macosVolumeUuidRetryAfterMs.get(device) ?? 0) > Date.now()) return;
	const existingQuery = macosVolumeUuidQueries.get(device);
	if (existingQuery) return existingQuery;
	const query = collectMacosVolumeUuid(physicalPath, device)
		.catch(() => {
			macosVolumeUuidRetryAfterMs.set(device, Date.now() + 5_000);
		})
		.finally(() => macosVolumeUuidQueries.delete(device));
	macosVolumeUuidQueries.set(device, query);
	return query;
}
async function collectMacosVolumeUuid(physicalPath: string, device: string) {
	const filesystem = (await executeMacosVolumeQuery("/bin/df", ["-P", physicalPath]))
		.trim()
		.split("\n")
		.at(-1)
		?.trim()
		.split(/\s+/)[0];
	if (!filesystem?.startsWith("/dev/")) throw new Error("Codex 目录所在卷暂不可核验，保留原绑定。");
	const filesystemDeviceNodeFingerprint = readMacosFilesystemDeviceNodeFingerprint(filesystem, device);
	if (!filesystemDeviceNodeFingerprint) throw new Error("Codex 目录所在块设备暂不可核验，保留原绑定。");
	const volumeInformation = await executeMacosVolumeQuery("/usr/sbin/diskutil", ["info", "-plist", filesystem]);
	if (readMacosFilesystemDeviceNodeFingerprint(filesystem, device) !== filesystemDeviceNodeFingerprint)
		throw new Error("Codex 卷查询期间设备节点已变化，等待稳定挂载后自动重试。");
	// 只读取 plist 中一个已知的 UUID 标量；UUID 校验排除实体与其他 XML 内容。
	const uuid = z
		.string()
		.uuid()
		.parse(/<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/.exec(volumeInformation)?.[1]);
	macosVolumeUuidCache.set(device, {
		uuid,
		expiresAtMs: Date.now() + 30_000,
		filesystemDeviceNodePath: filesystem,
		filesystemDeviceNodeFingerprint,
	});
}

export function runWithCodexDirectoryVolumeSystemQueriesDisabled<T>(operation: () => T): T {
	return codexDirectoryVolumeSystemQueriesDisabled.run(true, operation);
}

export async function prepareCodexDirectoryVolumeObservations(directoryPaths: Iterable<string>) {
	if (platform() !== "darwin") return;
	if (codexDirectoryVolumeSystemQueriesDisabled.getStore())
		throw new Error("Codex 配置 store 持锁期间不能预取系统卷观察。");
	await Promise.all(
		[...new Set(directoryPaths)].map(async (directoryPath) => {
			try {
				const physicalPath = realpathSync(directoryPath);
				await Promise.all([
					observeMacosBootSessionUuid(),
					observeMacosVolumeUuid(physicalPath, `${lstatSync(physicalPath, { bigint: true }).dev}`),
				]);
			} catch {
				// 预取不是资格结论；每个来源在实际操作时重核验，单个不可读目录不阻断其他来源。
			}
		}),
	);
}

export async function prepareCodexPersistentDirectoryIdentity(
	directoryPath: string,
	expectation?: CodexDirectoryIdentityExpectation,
) {
	if (!codexDirectoryVolumeSystemQueriesDisabled.getStore())
		await prepareCodexDirectoryVolumeObservations([directoryPath]);
	// 持锁期间只核验当前目录、节点、缓存与持久观察，绝不等待系统命令。
	return resolveCodexPersistentDirectoryIdentity(directoryPath, expectation);
}

function readEvidence(path: string) {
	if (!lstatSync(path).isFile()) throw new Error("Codex 目录身份补证不是普通文件，保留原绑定。");
	return evidenceSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function persistEvidence(path: string, evidence: DirectoryIdentityEvidence | VerifiedMountObservation) {
	const assertExistingRecordMatches = () => {
		if (!lstatSync(path).isFile()) throw new Error("Codex 目录身份补证不是普通文件，保留原绑定。");
		const existing = evidenceSchema.or(verifiedMountObservationSchema).parse(JSON.parse(readFileSync(path, "utf8")));
		if (
			existing.identityDigest !== evidence.identityDigest ||
			existing.physicalDirectoryPath !== evidence.physicalDirectoryPath ||
			existing.volumeUuid !== evidence.volumeUuid ||
			existing.inode !== evidence.inode ||
			existing.birthtimeNanoseconds !== evidence.birthtimeNanoseconds
		)
			throw new Error("Codex 目录身份补证发生冲突，保留原绑定。");
	};
	if (existsSync(path)) {
		assertExistingRecordMatches();
		return;
	}
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const pendingPath = `${path}.${randomUUID()}.pending`;
	const descriptor = openSync(pendingPath, "wx", 0o600);
	try {
		writeFileSync(descriptor, `${JSON.stringify(evidence)}\n`);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	try {
		// 原记录不可覆盖；完整文件原子出现，重启后不会读到半条补证。
		linkSync(pendingPath, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		assertExistingRecordMatches();
	} finally {
		rmSync(pendingPath, { force: true });
	}
}

export function resolveCodexPersistentDirectoryIdentity(
	directoryPath: string,
	expectation?: CodexDirectoryIdentityExpectation,
	persistIdentityEvidence = true,
) {
	const physicalPath = realpathSync(directoryPath);
	const metadata = lstatSync(physicalPath, { bigint: true });
	if (!metadata.isDirectory()) throw new Error("Codex 目录归属不再是目录。");
	const currentDeviceIdentity = digest([physicalPath, `${metadata.dev}`, `${metadata.ino}`]);
	if (platform() !== "darwin") {
		if (expectation && expectation.expectedIdentity !== currentDeviceIdentity)
			throw new Error("Codex 目录身份不符或已被替换，保留原绑定。");
		return currentDeviceIdentity;
	}
	const cachedVolume = macosVolumeUuidCache.get(`${metadata.dev}`);
	const volumeUuid =
		cachedVolume &&
		cachedVolume.expiresAtMs > Date.now() &&
		cachedVolume.filesystemDeviceNodeFingerprint ===
			readMacosFilesystemDeviceNodeFingerprint(cachedVolume.filesystemDeviceNodePath, `${metadata.dev}`)
			? cachedVolume.uuid
			: undefined;
	const evidenceDirectory = join(
		getRuntimeHomePath(),
		"codex-persistent-directory-identity-evidence",
		digest(physicalPath),
	);
	const mountObservationDirectory = join(evidenceDirectory, "verified-mount-observations");
	const hasVerifiedCurrentMountObservation = (evidence: DirectoryIdentityEvidence) => {
		if (!macosBootSessionUuid || !existsSync(mountObservationDirectory)) return false;
		for (const name of readdirSync(mountObservationDirectory).filter((name) =>
			name.startsWith(`${evidence.identityDigest}.`),
		)) {
			try {
				const observationPath = join(mountObservationDirectory, name);
				if (!lstatSync(observationPath).isFile()) continue;
				const observation = verifiedMountObservationSchema.parse(JSON.parse(readFileSync(observationPath, "utf8")));
				if (
					observation.identityDigest !== evidence.identityDigest ||
					observation.physicalDirectoryPath !== physicalPath ||
					observation.volumeUuid !== evidence.volumeUuid ||
					observation.inode !== `${metadata.ino}` ||
					observation.birthtimeNanoseconds !== `${metadata.birthtimeNs}` ||
					observation.bootSessionUuid !== macosBootSessionUuid ||
					observation.observedDeviceNumber !== `${metadata.dev}`
				)
					continue;
				const deviceNode = lstatSync(observation.filesystemDeviceNodePath, { bigint: true });
				if (
					deviceNode.isBlockDevice() &&
					`${deviceNode.rdev}` === `${metadata.dev}` &&
					`${deviceNode.rdev}` === observation.filesystemDeviceNodeNumber &&
					`${deviceNode.ino}` === observation.filesystemDeviceNodeInode &&
					`${deviceNode.ctimeNs}` === observation.filesystemDeviceNodeChangedAtNanoseconds
				)
					return true;
			} catch {
				// 单条观察损坏不能替代卷核验，也不否定其他完整的当前挂载观察。
			}
		}
		return false;
	};
	const persistVerifiedCurrentMountObservation = (evidence: DirectoryIdentityEvidence) => {
		if (!persistIdentityEvidence || !volumeUuid || !cachedVolume || !macosBootSessionUuid) return;
		const deviceNode = lstatSync(cachedVolume.filesystemDeviceNodePath, { bigint: true });
		const observedDeviceNodeFingerprint = digest([
			`${deviceNode.rdev}`,
			`${deviceNode.ino}`,
			`${deviceNode.ctimeNs}`,
		]);
		if (
			!deviceNode.isBlockDevice() ||
			deviceNode.rdev !== metadata.dev ||
			observedDeviceNodeFingerprint !== cachedVolume.filesystemDeviceNodeFingerprint
		)
			throw new Error("Codex 挂载设备节点在补证前变化，重新核验后自动重试；保留原绑定。");
		const observation: VerifiedMountObservation = {
			...evidence,
			observedDeviceNumber: `${metadata.dev}`,
			observedAtMs: Date.now(),
			evidenceKind: "verified_current_macos_mount",
			bootSessionUuid: macosBootSessionUuid,
			filesystemDeviceNodePath: cachedVolume.filesystemDeviceNodePath,
			filesystemDeviceNodeInode: `${deviceNode.ino}`,
			filesystemDeviceNodeChangedAtNanoseconds: `${deviceNode.ctimeNs}`,
			filesystemDeviceNodeNumber: `${deviceNode.rdev}`,
		};
		const mountQualificationDigest = digest([
			observation.bootSessionUuid,
			observation.observedDeviceNumber,
			observation.filesystemDeviceNodePath,
			observation.filesystemDeviceNodeInode,
			observation.filesystemDeviceNodeChangedAtNanoseconds,
			observation.filesystemDeviceNodeNumber,
		]);
		persistEvidence(
			join(mountObservationDirectory, `${evidence.identityDigest}.${mountQualificationDigest}.json`),
			observation,
		);
	};
	const matchesCurrentDirectory = (evidence: DirectoryIdentityEvidence) => {
		if (
			evidence.physicalDirectoryPath !== physicalPath ||
			evidence.inode !== `${metadata.ino}` ||
			evidence.birthtimeNanoseconds !== `${metadata.birthtimeNs}`
		)
			return false;
		if (volumeUuid) return evidence.volumeUuid === volumeUuid;
		// 历史查询只读，不启动系统子进程；原生执行前由异步入口补齐卷核验。
		if (!persistIdentityEvidence || hasVerifiedCurrentMountObservation(evidence)) return true;
		throw new Error("Codex 卷身份暂不可核验，系统查询恢复后自动重试；保留原绑定。");
	};
	const expectedIdentity = expectation?.expectedIdentity;
	if (expectedIdentity && !/^[a-f0-9]{64}$/.test(expectedIdentity))
		throw new Error("Codex 目录身份摘要无效，保留原绑定。");
	const evidencePath = expectedIdentity ? join(evidenceDirectory, `${expectedIdentity}.json`) : undefined;
	if (evidencePath && existsSync(evidencePath)) {
		const evidence = readEvidence(evidencePath);
		if (evidence.identityDigest !== expectedIdentity || !matchesCurrentDirectory(evidence))
			throw new Error("Codex 目录身份已变化或目录已被替换（卷、inode 或创建时间不符），保留原绑定。");
		persistVerifiedCurrentMountObservation(evidence);
		return expectedIdentity;
	}
	if (!expectation && existsSync(evidenceDirectory)) {
		const matches = readdirSync(evidenceDirectory)
			.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
			.map((name) => readEvidence(join(evidenceDirectory, name)))
			.filter(matchesCurrentDirectory)
			.sort((left, right) => left.boundAtMs - right.boundAtMs);
		if (matches[0]) {
			persistVerifiedCurrentMountObservation(matches[0]);
			return matches[0].identityDigest;
		}
	}
	let previousDeviceNumber = `${metadata.dev}`;
	if (expectation && expectedIdentity !== currentDeviceIdentity) {
		// 旧格式未保存卷 UUID。首次补证只接受同卷原清单、原路径、原 inode，
		// 且目录早于绑定；只枚举 Darwin 本地设备的有界 minor 编号，不猜目录或会话。
		const manifestPath = expectation.legacyBindingManifestPath;
		if (
			!manifestPath ||
			!expectation.boundAtMs ||
			metadata.birthtimeNs <= 0n ||
			metadata.birthtimeNs / 1_000_000n > BigInt(Math.floor(expectation.boundAtMs)) ||
			!lstatSync(manifestPath).isFile() ||
			lstatSync(manifestPath, { bigint: true }).dev !== metadata.dev
		)
			throw new Error("Codex 旧目录身份缺少可核验的原绑定证据，保留现场。");
		const deviceMajor = metadata.dev & ~0xffffffn;
		let matchedPreviousDevice: bigint | undefined;
		for (let minor = 0n; minor < 4096n; minor++) {
			const candidate = deviceMajor | minor;
			if (digest([physicalPath, `${candidate}`, `${metadata.ino}`]) === expectedIdentity) {
				matchedPreviousDevice = candidate;
				break;
			}
		}
		if (matchedPreviousDevice === undefined) throw new Error("Codex 原目录路径或 inode 不符，保留原绑定。");
		previousDeviceNumber = `${matchedPreviousDevice}`;
	}
	const identity = expectedIdentity ?? currentDeviceIdentity;
	if (!volumeUuid) {
		// 原设备身份仍精确匹配时继续沿用原门禁；系统查询失败不升级成全局停机。
		if (!persistIdentityEvidence || identity === currentDeviceIdentity) return identity;
		throw new Error("Codex 卷身份暂不可核验，系统查询恢复后自动重试；保留原绑定。");
	}
	if (persistIdentityEvidence) {
		const evidence: DirectoryIdentityEvidence = {
			schemaVersion: 1,
			identityDigest: identity,
			physicalDirectoryPath: physicalPath,
			volumeUuid,
			inode: `${metadata.ino}`,
			birthtimeNanoseconds: `${metadata.birthtimeNs}`,
			observedDeviceNumber: `${metadata.dev}`,
			previousDeviceNumber,
			boundAtMs: expectation?.boundAtMs ?? Date.now(),
			observedAtMs: Date.now(),
			evidenceKind:
				previousDeviceNumber === `${metadata.dev}`
					? "original_device_identity_matched"
					: "legacy_macos_device_number_changed",
			legacyBindingManifestPath: expectation?.legacyBindingManifestPath,
		};
		persistEvidence(join(evidenceDirectory, `${identity}.json`), evidence);
		persistVerifiedCurrentMountObservation(evidence);
	}
	return identity;
}
