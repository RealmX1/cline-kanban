import { execFile, spawn } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TaskCommandExecutionRecord } from "../core/task-command-execution-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { taskCommandExecutionArtifactDirectory } from "./task-command-execution-store";

const executeFile = promisify(execFile);
async function readSystemBootIdentity(): Promise<string | null> {
	try {
		return process.platform === "linux"
			? (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
			: process.platform === "darwin"
				? (await executeFile("sysctl", ["-n", "kern.bootsessionuuid"], { timeout: 5_000 })).stdout.trim()
				: null;
	} catch {
		return null;
	}
}
interface OwnedProcessIdentity {
	pid: number;
	startAndCommand: string;
}
// command 会随 exec / process.title 改变；PID 与启动时刻共同界定进程代际。
function hasSameProcessGeneration(
	current: OwnedProcessIdentity | null | undefined,
	expected: OwnedProcessIdentity | undefined,
): boolean {
	if (!current || !expected || current.pid !== expected.pid) return false;
	const processStartIdentity = (identity: OwnedProcessIdentity) =>
		identity.startAndCommand.match(/^\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}(?=\s|$)/)?.[0];
	const currentStart = processStartIdentity(current);
	return currentStart !== undefined && currentStart === processStartIdentity(expected);
}
async function readProcessIdentity(pid: number): Promise<OwnedProcessIdentity | null> {
	try {
		const { stdout } = await executeFile("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
			timeout: 5_000,
		});
		return stdout.trim() ? { pid, startAndCommand: stdout.trim() } : null;
	} catch (error) {
		if ((error as { code?: number }).code === 1) return null;
		throw error;
	}
}

// 独立监督进程不加载 runtime 或插件依赖；启动材料、唯一 nonce 和进程身份均先落盘。
const supervisorSource = String.raw`
import { spawn, execFileSync } from 'node:child_process';
import { open, readFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
const materialsFile = process.argv[2];
const materials = JSON.parse(await readFile(materialsFile, 'utf8'));
const directory = materials.directory;
const nonce = materials.launchNonce;
async function save(name, value) {
 const target=join(directory,name); const staging=target+'.'+process.pid+'.pending';
 const handle=await open(staging,'w',0o600); await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); await rename(staging,target);
}
function identity(pid) {
 try { const value=execFileSync('ps',['-p',String(pid),'-o','lstart=','-o','command='],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']}).trim(); return value ? {pid,startAndCommand:value}:null; }
 catch(error) { if(error.status===1)return null; throw error; }
}
function hasSameProcessGeneration(current,expected) {
 if(!current || !expected || current.pid!==expected.pid)return false;
 const processStartIdentity=entry=>entry.startAndCommand.match(/^\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}(?=\s|$)/)?.[0];
 const currentStart=processStartIdentity(current);return currentStart!==undefined && currentStart===processStartIdentity(expected);
}
async function revoked() { try { await readFile(materials.revocationFile); return true; } catch(error) { if(error.code==='ENOENT')return false; throw error; } }
await mkdir(directory,{recursive:true});
const claimPath=join(directory,'supervisor-claim-'+nonce+'.json');
try { const claim=await open(claimPath,'wx',0o600); await claim.writeFile(JSON.stringify(identity(process.pid))); await claim.sync(); await claim.close(); }
catch(error) { if(error.code!=='EEXIST')throw error; const owner=JSON.parse(await readFile(claimPath,'utf8')); const current=identity(owner.pid); if(hasSameProcessGeneration(current,owner)) { process.exitCode=0; } else { await unlink(claimPath); const claim=await open(claimPath,'wx',0o600); await claim.writeFile(JSON.stringify(identity(process.pid))); await claim.sync(); await claim.close(); } }
const owner=JSON.parse(await readFile(claimPath,'utf8'));
if(owner.pid===process.pid) {
 await save('supervisor-identity-'+nonce+'.json',{...identity(process.pid),launchNonce:nonce});
 let child=null; let cancelled=false; let cancellationStartedAtEpochMs=null; const owned=new Map();
 function collect() {
  if(!child?.pid)return;
  const lines=execFileSync('ps',['-axo','pid=,ppid=,lstart=,command='],{encoding:'utf8',timeout:5000,maxBuffer:32*1024*1024}).split('\n');
  const entries=lines.map(line=>line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(match=>({pid:Number(match[1]),parent:Number(match[2]),startAndCommand:match[3].trim()}));
  const parents=new Set(entries.filter(entry=>hasSameProcessGeneration(entry,owned.get(entry.pid))).map(entry=>entry.pid)); let changed=true;
  while(changed){changed=false;for(const entry of entries)if(entry.pid!==process.pid && parents.has(entry.parent)&&!parents.has(entry.pid)){parents.add(entry.pid);changed=true;}}
  for(const entry of entries)if(parents.has(entry.pid))owned.set(entry.pid,{pid:entry.pid,startAndCommand:entry.startAndCommand});
 }
 function terminate() {
  collect();
  cancelled=true;
  cancellationStartedAtEpochMs ??= Date.now();
  const signal=Date.now()-cancellationStartedAtEpochMs>=1000?'SIGKILL':'SIGTERM';
  for(const entry of [...owned.values()].reverse()) { const current=identity(entry.pid); if(hasSameProcessGeneration(current,entry)) { try { process.kill(entry.pid,signal); }catch{} } }
 }
 process.on('SIGTERM',terminate); process.on('SIGINT',terminate);
 if(!await revoked()) {
  const stdout=await open(join(directory,'command-'+nonce+'.stdout.txt'),'a',0o600); const stderr=await open(join(directory,'command-'+nonce+'.stderr.txt'),'a',0o600);
  child=spawn(materials.command[0],materials.command.slice(1),{cwd:materials.workingDirectory,env:{...process.env,KANBAN_COMMAND_EXECUTION_ID:materials.executionId,KANBAN_COMMAND_EXECUTION_REVOCATION_FILE:materials.revocationFile},detached:true,stdio:['ignore',stdout.fd,stderr.fd]});
  const completion=new Promise(resolve=>{child.once('error',error=>resolve({error:String(error),returncode:null}));child.once('exit',(code,signal)=>resolve({returncode:code,signal}));});
  if(child.pid) { const childIdentity=identity(child.pid); if(childIdentity)owned.set(child.pid,childIdentity); }
  await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:'running',ownedProcesses:[...owned.values()],updatedAtEpochMs:Date.now()});
  await stdout.close();await stderr.close();
  let settled=null;void completion.then(value=>{settled=value;});
  while(true) {
   collect(); if(cancelled || await revoked())terminate();
   if(settled!==null && ![...owned.values()].some(entry=>hasSameProcessGeneration(identity(entry.pid),entry)))break;
   await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:cancelled?'cancelling':'running',ownedProcesses:[...owned.values()],updatedAtEpochMs:Date.now()});
   await (settled===null?Promise.race([completion,new Promise(resolve=>setTimeout(resolve,200))]):new Promise(resolve=>setTimeout(resolve,200)));
  }
  if(cancelled)terminate();
  await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:cancelled?'cancelled':'exited',...settled,ownedProcesses:[...owned.values()],updatedAtEpochMs:Date.now()});
 } else await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:'cancelled',ownedProcesses:[],updatedAtEpochMs:Date.now()});
}
`;

export async function inspectOwnedCommandSupervisor(
	record: TaskCommandExecutionRecord,
): Promise<"running" | "exited" | "not_started" | "unknown"> {
	const directory = taskCommandExecutionArtifactDirectory(record.workspaceId, record.executionId);
	let hasPersistedSupervisorIdentity = false;
	try {
		const owner = JSON.parse(
			await readFile(join(directory, `supervisor-identity-${record.launchNonce}.json`), "utf8"),
		) as OwnedProcessIdentity;
		hasPersistedSupervisorIdentity = true;
		const current = await readProcessIdentity(owner.pid);
		if (hasSameProcessGeneration(current, owner)) return "running";
		const materials = JSON.parse(
			await readFile(join(directory, `launch-materials-${record.launchNonce}.json`), "utf8"),
		) as { systemBootIdentity: string | null };
		const currentBoot = await readSystemBootIdentity();
		if (currentBoot && materials.systemBootIdentity && currentBoot !== materials.systemBootIdentity) return "exited";
		const progress = JSON.parse(
			await readFile(join(directory, `supervisor-progress-${record.launchNonce}.json`), "utf8"),
		) as { status: string; ownedProcesses: OwnedProcessIdentity[] };
		for (const process of progress.ownedProcesses) {
			if (hasSameProcessGeneration(await readProcessIdentity(process.pid), process)) return "running";
		}
		// 过期快照可能遗漏失联前刚派生的孤儿；只有终结原件或开机代际变化才能证明全部退出。
		return progress.status === "exited" || progress.status === "cancelled" ? "exited" : "unknown";
	} catch (error) {
		if (hasPersistedSupervisorIdentity || (error as NodeJS.ErrnoException).code !== "ENOENT") return "unknown";
		try {
			const { stdout } = await executeFile("ps", ["-axo", "command="], { timeout: 5_000 });
			if (
				stdout
					.split("\n")
					.some((line) => line.includes(join(directory, `launch-materials-${record.launchNonce}.json`)))
			)
				return "running";
		} catch {
			return "unknown";
		}
		try {
			// 启动材料存在时，监督者可能已派生 worker，缺少首份进度不能证明尚未启动。
			await readFile(join(directory, `launch-materials-${record.launchNonce}.json`), "utf8");
			return "unknown";
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? "not_started" : "unknown";
		}
	}
}

export async function launchOwnedCommandSupervisor(
	record: TaskCommandExecutionRecord,
	validate: () => Promise<void>,
): Promise<void> {
	const directory = taskCommandExecutionArtifactDirectory(record.workspaceId, record.executionId);
	await mkdir(directory, { recursive: true });
	await lockedFileSystem.withLock({ path: join(directory, "supervisor-launch"), type: "file" }, async () => {
		await validate();
		if ((await inspectOwnedCommandSupervisor(record)) === "running") return;
		const entrypoint = join(directory, "owned-command-supervisor.mjs");
		const materialsFile = join(directory, `launch-materials-${record.launchNonce}.json`);
		await lockedFileSystem.writeTextFileAtomic(entrypoint, supervisorSource, { durable: true });
		await lockedFileSystem.writeJsonFileAtomic(
			materialsFile,
			{
				directory,
				launchNonce: record.launchNonce,
				executionId: record.executionId,
				revocationFile: record.revocationFile,
				workingDirectory: record.specification.workingDirectory,
				command: record.launchAttemptCount > 1 ? record.specification.resumeCommand : record.specification.command,
				systemBootIdentity: await readSystemBootIdentity(),
			},
			{ durable: true },
		);
		await validate();
		const log = await open(join(directory, `supervisor-${record.launchNonce}.log`), "a", 0o600);
		try {
			const supervisor = spawn(process.execPath, [entrypoint, materialsFile], {
				detached: true,
				stdio: ["ignore", log.fd, log.fd],
			});
			await new Promise<void>((resolve, reject) => {
				supervisor.once("spawn", resolve);
				supervisor.once("error", reject);
			});
			supervisor.unref();
		} finally {
			await log.close();
		}
	});
}

export async function cancelOwnedCommandProcesses(
	record: Pick<
		TaskCommandExecutionRecord,
		"workspaceId" | "executionId" | "launchNonce" | "previousLaunchNonces" | "revocationFile"
	> & {
		specification: Pick<TaskCommandExecutionRecord["specification"], "cancelCommand" | "workingDirectory">;
	},
): Promise<Record<string, unknown>> {
	const directory = taskCommandExecutionArtifactDirectory(record.workspaceId, record.executionId);
	const observations: Record<string, unknown>[] = [];
	const cancelCommand = record.specification.cancelCommand;
	if (cancelCommand?.[0]) {
		try {
			await executeFile(cancelCommand[0], cancelCommand.slice(1), {
				cwd: record.specification.workingDirectory,
				timeout: 15_000,
				killSignal: "SIGKILL",
				env: { ...process.env, KANBAN_COMMAND_EXECUTION_REVOCATION_FILE: record.revocationFile },
			});
		} catch (error) {
			observations.push({ cancelCommandStatus: "unknown", reason: String(error) });
		}
	}
	try {
		const ownedProcesses: OwnedProcessIdentity[] = [];
		for (const nonce of [...record.previousLaunchNonces, record.launchNonce]) {
			try {
				const progress = JSON.parse(
					await readFile(join(directory, `supervisor-progress-${nonce}.json`), "utf8"),
				) as { ownedProcesses: OwnedProcessIdentity[] };
				ownedProcesses.push(...progress.ownedProcesses);
			} catch {
				observations.push({
					launchNonce: nonce,
					status: "unknown",
					recoveryTrigger: "owned_process_identity_available",
				});
			}
		}
		const terminationRequestedOwners: OwnedProcessIdentity[] = [];
		for (const owner of ownedProcesses.reverse()) {
			try {
				const current = await readProcessIdentity(owner.pid);
				if (hasSameProcessGeneration(current, owner)) {
					process.kill(owner.pid, "SIGTERM");
					terminationRequestedOwners.push(owner);
				}
				observations.push({
					pid: owner.pid,
					status: current
						? hasSameProcessGeneration(current, owner)
							? "termination_requested"
							: "identity_changed_no_signal"
						: "exited",
				});
			} catch {
				observations.push({ pid: owner.pid, status: "unknown" });
			}
		}
		if (terminationRequestedOwners.length > 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
			for (const owner of terminationRequestedOwners) {
				try {
					const current = await readProcessIdentity(owner.pid);
					if (hasSameProcessGeneration(current, owner)) process.kill(owner.pid, "SIGKILL");
					observations.push({
						pid: owner.pid,
						status: hasSameProcessGeneration(current, owner)
							? "force_termination_requested"
							: current
								? "identity_changed_no_signal"
								: "exited",
					});
				} catch {
					observations.push({ pid: owner.pid, status: "unknown" });
				}
			}
		}
	} catch {
		observations.push({ status: "unknown", recoveryTrigger: "owned_process_identity_available" });
	}
	return {
		localProcessObservations: observations,
		nativeCancellationStatus: "unknown",
		recoveryTrigger: "native_cancellation_evidence_changed",
	};
}
