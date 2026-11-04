import { join, resolve } from "node:path";
import { restoreExecutionEnvironmentIntoPrivateDirectories } from "./restore-execution-environment";
import { verifyReusableTaskCohortBackup } from "./verify-reusable-cohort-backup";

const root = process.argv[2];
if (!root) throw new Error("缺少备份根目录");

(async () => {
	const result = await verifyReusableTaskCohortBackup(resolve(root));
	await restoreExecutionEnvironmentIntoPrivateDirectories(
		resolve(root),
		join(resolve(root), "offline-restoration-validation", "private-execution-environment"),
	);
	return result;
})()
	.then((result) => {
		console.log(
			JSON.stringify({
				status: result.status,
				restoredTaskCount: result.restoredTasks.length,
				verifiedFileCount: result.verifiedFileCount,
			}),
		);
	})
	.catch((error: unknown) => {
		console.error(String(error));
		process.exitCode = 1;
	});
