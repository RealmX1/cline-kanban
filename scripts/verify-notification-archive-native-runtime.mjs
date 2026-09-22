import assert from "node:assert/strict";
import Database from "better-sqlite3";

// 必须由部署时实际启动服务的 Node 执行；只读写内存，不接触用户档案。
let database;
try {
	database = new Database(":memory:");
	database.exec("CREATE TABLE notification_archive_runtime_probe (value INTEGER NOT NULL)");
	database.prepare("INSERT INTO notification_archive_runtime_probe (value) VALUES (?)").run(1);
	assert.equal(database.prepare("SELECT value FROM notification_archive_runtime_probe").get().value, 1);
	console.log(`通知档案原生依赖检查通过：${process.execPath} (${process.version}, ABI ${process.versions.modules})`);
} catch (cause) {
	throw new Error(
		`通知档案原生依赖检查失败：${process.execPath} (${process.version}, ABI ${process.versions.modules})。` +
			"请在此 checkout 使用实际启动服务的 Node 对应的 npm rebuild better-sqlite3，然后用同一 Node 重跑本检查；不得继续部署。",
		{ cause },
	);
} finally {
	database?.close();
}
