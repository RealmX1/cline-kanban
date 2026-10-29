import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { CurrentBuildAgentSessionPtyHostDescriptor } from "./agent-session-pty-host-build-identity-and-launch-command";

export function readAgentSessionPtyHostRecoveryEvidenceFingerprint(
	descriptor: CurrentBuildAgentSessionPtyHostDescriptor,
	configurationEvidenceFilePath?: string,
): string {
	const hash = createHash("sha256")
		.update(descriptor.hostBuildIdentity)
		.update(JSON.stringify(descriptor.launchCommand));
	const paths = [descriptor.launchCommand.executablePath, ...descriptor.launchCommand.leadingArguments];
	try {
		const packageDirectory = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
		for (const directory of [
			join(packageDirectory, "build/Release"),
			join(packageDirectory, "prebuilds", `${process.platform}-${process.arch}`),
		]) {
			try {
				paths.push(...readdirSync(directory).map((entry) => join(directory, entry)));
			} catch {
				paths.push(directory);
			}
		}
	} catch (error) {
		hash.update(String(error));
	}
	for (const path of paths) {
		try {
			const status = statSync(path);
			hash.update(`${path}:${status.ino}:${status.size}:${status.mtimeMs}`);
		} catch (error) {
			hash.update(`${path}:${(error as NodeJS.ErrnoException).code}`);
		}
	}
	if (configurationEvidenceFilePath) {
		try {
			hash.update(readFileSync(configurationEvidenceFilePath));
		} catch (error) {
			hash.update(`${configurationEvidenceFilePath}:${(error as NodeJS.ErrnoException).code}`);
		}
	}
	return hash.digest("hex");
}
