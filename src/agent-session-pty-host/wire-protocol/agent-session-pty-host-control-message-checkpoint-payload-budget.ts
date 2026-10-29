// checkpoint 可降级为环形缓冲重放；会话身份和其它接管字段必须完整保留。
export function omitPlannedHandoverTerminalMirrorCheckpointFromAdoptionRecord(adoptionRecord: unknown): unknown {
	if (typeof adoptionRecord !== "object" || adoptionRecord === null || Array.isArray(adoptionRecord)) {
		return adoptionRecord;
	}
	const recordWithoutCheckpoint = { ...adoptionRecord } as Record<string, unknown>;
	delete recordWithoutCheckpoint.plannedHandoverTerminalMirrorCheckpoint;
	return recordWithoutCheckpoint;
}
