import { createDailyWorkProgressStatisticsService } from "../../../src/daily-work-progress-statistics/daily-work-progress-statistics-service";

const [storageFilePath, serializedRequest] = process.argv.slice(2);
if (!storageFilePath || !serializedRequest) throw new Error("缺少独立领取进程的文件与请求");
const service = createDailyWorkProgressStatisticsService({
	storageFilePath,
	collect: async () => ({
		projects: [{ workspaceId: "project", projectName: "隔离项目" }],
		liveFactEventIds: [],
		hasPendingHistoricalReads: false,
	}),
	warn: () => {},
});
try {
	const result = await service.claimCelebrations(JSON.parse(serializedRequest));
	process.stdout.write(JSON.stringify(result));
} finally {
	await service.close();
}
