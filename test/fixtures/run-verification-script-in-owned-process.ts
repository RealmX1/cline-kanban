import type { RuntimePostDeployVerificationChecklistItem } from "../../src/core/api-contract";
import { runVerificationScript } from "../../src/deployment/verification-script-runner";

interface OwnedVerificationScriptProcessInput {
	verificationId: string;
	script: NonNullable<RuntimePostDeployVerificationChecklistItem["script"]>;
	startedAtIso: string;
	finishedAtIso: string;
}

async function main(): Promise<void> {
	const serializedInput = process.argv[2];
	if (!serializedInput) {
		throw new Error("Owned verification script helper requires one serialized input argument");
	}
	const input = JSON.parse(serializedInput) as OwnedVerificationScriptProcessInput;
	const outcome = await runVerificationScript({
		verificationId: input.verificationId,
		script: input.script,
		startedAtIso: input.startedAtIso,
		finishedAtIsoProvider: () => input.finishedAtIso,
	});
	process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
	process.exitCode = 1;
});
