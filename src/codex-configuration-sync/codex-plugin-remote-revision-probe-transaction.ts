// 只在一次来源锁内持有；未知结果也复用，安装事实变化后必须重新核验。
export function createCodexPluginRemoteRevisionProbeTransaction(
	probeRemoteGitRevision: (url: string, ref: string | null) => Promise<string | undefined>,
) {
	const remoteRevisionProbeResultsBySourceUrlAndRef = new Map<string, Promise<string | undefined>>();
	return {
		read(url: string, ref: string | null) {
			const sourceUrlAndRefKey = JSON.stringify([url, ref]);
			let result = remoteRevisionProbeResultsBySourceUrlAndRef.get(sourceUrlAndRefKey);
			if (!result) {
				result = probeRemoteGitRevision(url, ref);
				remoteRevisionProbeResultsBySourceUrlAndRef.set(sourceUrlAndRefKey, result);
			}
			return result;
		},
		invalidateAfterSourceInstallationFactsChanged: () => remoteRevisionProbeResultsBySourceUrlAndRef.clear(),
		hasUnverifiedRevisionProbes: async () =>
			(await Promise.all(remoteRevisionProbeResultsBySourceUrlAndRef.values())).some(
				(revision) => revision === undefined,
			),
	};
}
