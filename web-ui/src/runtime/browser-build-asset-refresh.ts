const SERVED_INDEX_BUILD_ASSET_SELECTOR =
	'script[type="module"][src], link[rel="stylesheet"][href], link[rel="modulepreload"][href]';

interface ReloadBrowserIfServedBuildAssetsChangedDependencies {
	currentDocument?: Document;
	fetchIndexHtml?: typeof window.fetch;
	location?: Location;
	reloadWindow?: () => void;
}

function normalizeBuildAssetIdentifier(rawUrl: string, baseUrl: string): string | null {
	try {
		const parsed = new URL(rawUrl, baseUrl);
		return `${parsed.pathname}${parsed.search}`;
	} catch {
		return null;
	}
}

export function readBuildAssetIdentifiersFromDocument(documentToRead: Document, baseUrl: string): string[] {
	const identifiers = new Set<string>();
	for (const element of documentToRead.querySelectorAll(SERVED_INDEX_BUILD_ASSET_SELECTOR)) {
		const rawUrl =
			element instanceof HTMLScriptElement ? element.src : element instanceof HTMLLinkElement ? element.href : "";
		const identifier = normalizeBuildAssetIdentifier(rawUrl, baseUrl);
		if (identifier) {
			identifiers.add(identifier);
		}
	}
	return Array.from(identifiers).sort();
}

export function readBuildAssetIdentifiersFromHtml(indexHtml: string, baseUrl: string): string[] {
	const parsedDocument = new DOMParser().parseFromString(indexHtml, "text/html");
	return readBuildAssetIdentifiersFromDocument(parsedDocument, baseUrl);
}

export function didServedBuildAssetIdentifiersChange(
	currentBuildAssetIdentifiers: string[],
	servedBuildAssetIdentifiers: string[],
): boolean {
	if (currentBuildAssetIdentifiers.length === 0 || servedBuildAssetIdentifiers.length === 0) {
		return false;
	}
	if (currentBuildAssetIdentifiers.length !== servedBuildAssetIdentifiers.length) {
		return true;
	}
	for (let index = 0; index < currentBuildAssetIdentifiers.length; index += 1) {
		if (currentBuildAssetIdentifiers[index] !== servedBuildAssetIdentifiers[index]) {
			return true;
		}
	}
	return false;
}

export async function reloadBrowserIfServedBuildAssetsChanged({
	currentDocument = document,
	fetchIndexHtml = window.fetch.bind(window),
	location = window.location,
	reloadWindow = () => window.location.reload(),
}: ReloadBrowserIfServedBuildAssetsChangedDependencies = {}): Promise<boolean> {
	const currentUrl = location.href;
	const currentBuildAssetIdentifiers = readBuildAssetIdentifiersFromDocument(currentDocument, currentUrl);
	if (currentBuildAssetIdentifiers.length === 0) {
		return false;
	}

	const indexHtmlUrl = new URL(currentUrl);
	indexHtmlUrl.search = "";
	indexHtmlUrl.hash = "";

	try {
		const response = await fetchIndexHtml(indexHtmlUrl.toString(), {
			cache: "no-store",
			headers: {
				Accept: "text/html",
			},
		});
		if (!response.ok) {
			return false;
		}
		const servedIndexHtml = await response.text();
		const servedBuildAssetIdentifiers = readBuildAssetIdentifiersFromHtml(
			servedIndexHtml,
			response.url || indexHtmlUrl.toString(),
		);
		if (!didServedBuildAssetIdentifiersChange(currentBuildAssetIdentifiers, servedBuildAssetIdentifiers)) {
			return false;
		}
		reloadWindow();
		return true;
	} catch {
		return false;
	}
}
