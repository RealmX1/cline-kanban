export function readBrowserFileAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result !== "string" || !reader.result.includes(",")) {
				reject(new Error("无法读取附件内容。"));
				return;
			}
			resolve(reader.result.slice(reader.result.indexOf(",") + 1));
		};
		reader.onerror = reader.onabort = () => reject(new Error("附件读取失败，请重新选择。"));
		reader.readAsDataURL(file);
	});
}
