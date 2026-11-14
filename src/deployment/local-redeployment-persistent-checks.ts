import { lstat, readdir, readFile, readlink, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import {
	localRedeploymentSha256,
	readLocalRedeploymentJson,
	writeLocalRedeploymentJson,
} from "./local-redeployment-preparation";

export async function reuseLocalRedeploymentCheck<T>(input: {
	directory: string;
	checkKey: string;
	inputFingerprint: string;
	read: () => Promise<{ value: T; evidenceSource: string }>;
	validate: (value: unknown) => value is T;
}): Promise<T> {
	const path = join(input.directory, "verification-checkpoints", `${localRedeploymentSha256(input.checkKey)}.json`);
	const original = (await readLocalRedeploymentJson(path)) as { inputFingerprint?: string; value?: unknown } | null;
	if (original?.inputFingerprint === input.inputFingerprint && input.validate(original.value)) return original.value;
	const failurePath = join(
		input.directory,
		"machine-evidence-requests",
		`${localRedeploymentSha256(input.checkKey)}.json`,
	);
	let result: { value: T; evidenceSource: string };
	try {
		result = await input.read();
		if (!input.validate(result.value)) throw new Error(`核验结果身份或结构不完整：${input.checkKey}`);
	} catch (error) {
		await writeLocalRedeploymentJson(failurePath, { kind: "verification_check", checkKey: input.checkKey });
		throw error;
	}
	await writeLocalRedeploymentJson(path, {
		checkKey: input.checkKey,
		inputFingerprint: input.inputFingerprint,
		...result,
		checkedAtEpochMs: Date.now(),
	});
	await rm(failurePath, { force: true });
	return result.value;
}

export async function recordLocalRedeploymentFilesystemEvidenceRequest(
	directory: string,
	error: unknown,
	stage = "candidate_bootstrap",
): Promise<void> {
	const path = error instanceof Error && "path" in error && typeof error.path === "string" ? error.path : null;
	if (path?.startsWith("/"))
		await writeLocalRedeploymentJson(
			join(directory, "machine-evidence-requests", `${localRedeploymentSha256(path)}.json`),
			{ kind: "filesystem_path", path, stage },
		);
}

export async function observeLocalRedeploymentFilesystemEvidence(path: string): Promise<unknown> {
	try {
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink()) return { kind: "symbolic_link", target: await readlink(path) };
		if (metadata.isFile())
			return {
				kind: "file",
				mode: metadata.mode,
				sha256:
					metadata.size <= 8 * 1024 * 1024
						? localRedeploymentSha256(await readFile(path))
						: "content_exceeds_observation_budget",
			};
		return { kind: metadata.isDirectory() ? "directory" : "other", mode: metadata.mode };
	} catch (error) {
		return { kind: "unavailable", code: (error as NodeJS.ErrnoException).code ?? "unknown" };
	}
}

export async function readLocalRedeploymentMachineEvidenceRequests(
	directory: string,
): Promise<Array<{ kind: string; path?: string; checkKey?: string; stage?: string; scope?: string }>> {
	const requests = [];
	for (const prefix of ["", "before-publication", "after-runtime-validation"]) {
		const root = join(directory, prefix, "machine-evidence-requests");
		const names = await readdir(root).catch((error: unknown) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		});
		for (const name of names.sort()) {
			if (!name.endsWith(".json")) continue;
			const value = (await readLocalRedeploymentJson(join(root, name))) as {
				kind: string;
				path?: string;
				checkKey?: string;
				stage?: string;
			} | null;
			if (value && ["verification_check", "filesystem_path"].includes(value.kind))
				requests.push({ ...value, scope: prefix });
		}
	}
	return requests;
}

export async function observeLocalRedeploymentDiskAvailability(directory: string): Promise<string> {
	try {
		const state = await statfs(directory);
		return state.bavail * state.bsize >= 16 * 1024 * 1024 ? "at_least_16_mib_available" : "below_16_mib_available";
	} catch {
		return "unknown";
	}
}

export async function clearLocalRedeploymentFilesystemEvidenceRequests(
	directory: string,
	stage: string,
): Promise<void> {
	for (const request of await readLocalRedeploymentMachineEvidenceRequests(directory)) {
		if (request.kind === "filesystem_path" && request.stage === stage && request.path)
			await rm(join(directory, "machine-evidence-requests", `${localRedeploymentSha256(request.path)}.json`), {
				force: true,
			});
	}
}
