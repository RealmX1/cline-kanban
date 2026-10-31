#!/usr/bin/env node
// 仅替换原生 Codex TUI；启动、浏览器、PTY、编辑器桥接和 Prompt Library 均使用产品实现。
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
if (process.argv.includes("--version")) { process.stdout.write("codex-cli 0.166.0\n"); process.exit(0); }
if (process.argv.includes("--help")) { process.stdout.write("隔离 Codex 草稿导出测试替身\n"); process.exit(0); }
const evidencePath = process.env.KANBAN_ISOLATED_DRAFT_EDITOR_EVIDENCE_PATH;
const nativeEditorFilePath = path.join(process.env.HOME, "isolated-codex-native-editor.md");
const ESC = String.fromCharCode(27);
const pasteStart = ESC + "[200~";
const pasteEnd = ESC + "[201~";
let composition = "";
let pending = "";
let insidePaste = false;
function record(event) { fs.appendFileSync(evidencePath, JSON.stringify(event) + "\n"); }
function redraw() {
  const displayed = composition ? `[Pasted Content ${Array.from(composition).length} chars]` : ESC + "[2mAsk Codex to do anything" + ESC + "[0m";
  process.stdout.write(ESC + "[2J" + ESC + "[H› " + displayed + "\r\n  隔离 Codex 草稿输入框" + ESC + "[1;3H");
}
function openEditor() {
  fs.writeFileSync(nativeEditorFilePath, composition);
  record({ event: "editor_started", text: composition });
  const child = spawn("/bin/sh", ["-c", `exec ${process.env.VISUAL} "$1"`, "isolated-editor", nativeEditorFilePath], { stdio: "inherit" });
  child.on("exit", (code) => {
    if (code === 0) composition = fs.readFileSync(nativeEditorFilePath, "utf8").trimEnd();
    record({ event: "editor_finished", code, text: composition });
    redraw();
  });
}
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  while (pending) {
    if (insidePaste) {
      const end = pending.indexOf(pasteEnd);
      if (end < 0) return;
      composition += pending.slice(0, end).replaceAll("\r", "\n");
      pending = pending.slice(end + pasteEnd.length);
      insidePaste = false;
    } else if (pending.startsWith(pasteStart)) {
      pending = pending.slice(pasteStart.length); insidePaste = true;
    } else if (pending.charCodeAt(0) === 7) {
      pending = pending.slice(1); openEditor();
    } else if (pending.charCodeAt(0) === 13) {
      record({ event: "user_submission", text: composition }); composition = ""; pending = pending.slice(1);
    } else if (pending.charCodeAt(0) === 3) {
      composition = ""; pending = pending.slice(1);
    } else if (pending.charCodeAt(0) === 27) {
      const sequence = /^\x1b\[[0-9;?<>]*[A-Za-z~]/u.exec(pending);
      if (!sequence) return;
      pending = pending.slice(sequence[0].length);
    } else {
      composition += pending[0]; pending = pending.slice(1);
    }
  }
  record({ event: "composer", text: composition });
  redraw();
});
process.stdout.write(ESC + "[?2004h");
record({ event: "composer", text: composition });
redraw();
