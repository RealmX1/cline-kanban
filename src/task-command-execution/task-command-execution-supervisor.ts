import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import pLimit from "p-limit";
import type { TaskCommandExecutionRecord } from "../core/task-command-execution-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { prepareDarwinProcessOriginalParentGenerationProbe } from "./darwin-process-original-parent-generation-probe";
import { prepareLinuxKernelChildSubreaperContainmentAddon } from "./linux-kernel-child-subreaper-containment-addon";
import { taskCommandExecutionArtifactDirectory } from "./task-command-execution-store";

const executeFile = promisify(execFile);
const limitProcessIdentityQueries = pLimit(8);
export async function readSystemBootIdentity(): Promise<string | null> {
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
export interface OwnedProcessIdentity {
	pid: number;
	startAndCommand: string;
	nativeProcessGenerationIdentity?: string;
}
// command 会随 exec / process.title 改变；PID 与启动时刻共同界定进程代际。
export function hasSameProcessGeneration(
	current: OwnedProcessIdentity | null | undefined,
	expected: OwnedProcessIdentity | undefined,
): boolean {
	if (!current || !expected || current.pid !== expected.pid) return false;
	if (expected.nativeProcessGenerationIdentity !== undefined)
		return current.nativeProcessGenerationIdentity === expected.nativeProcessGenerationIdentity;
	const processStartIdentity = (identity: OwnedProcessIdentity) =>
		identity.startAndCommand.match(/^\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}(?=\s|$)/)?.[0];
	const currentStart = processStartIdentity(current);
	return currentStart !== undefined && currentStart === processStartIdentity(expected);
}
export async function readProcessIdentity(
	pid: number,
	darwinNativeProbePath?: string | null,
	requireNativeProcessGenerationIdentity = false,
): Promise<OwnedProcessIdentity | null> {
	return limitProcessIdentityQueries(async () => {
		try {
			const { stdout } = await executeFile(
				"ps",
				["-p", String(pid), "-o", "stat=", "-o", "lstart=", "-o", "command="],
				{
					timeout: 5_000,
					env: { ...process.env, LC_ALL: "C" },
				},
			);
			if (!stdout.trim()) return null;
			const row = stdout.trim().match(/^(\S+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}(?:\s.*)?)$/s);
			if (row?.[1] && /^[ZX]/.test(row[1])) return null;
			let nativeProcessGenerationIdentity: string | undefined;
			if (process.platform === "linux" && requireNativeProcessGenerationIdentity) {
				const stat = await readFile(`/proc/${pid}/stat`, "utf8");
				const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
				if (ticks) nativeProcessGenerationIdentity = `linux:${ticks}`;
			} else if (darwinNativeProbePath) {
				const records = JSON.parse(
					(await executeFile(darwinNativeProbePath, ["", String(pid)], { timeout: 1000 })).stdout,
				) as { pid: number; processUniqueIdentity: string }[];
				const uniqueIdentity = records.find((entry) => entry.pid === pid)?.processUniqueIdentity;
				if (uniqueIdentity && /^\d+$/.test(uniqueIdentity))
					nativeProcessGenerationIdentity = `darwin_unique_process_id:${uniqueIdentity}`;
			}
			return {
				pid,
				startAndCommand: row?.[2] ?? stdout.trim(),
				...(nativeProcessGenerationIdentity ? { nativeProcessGenerationIdentity } : {}),
			};
		} catch (error) {
			if ((error as { code?: number | string }).code === 1 || (error as { code?: string }).code === "ENOENT")
				return null;
			throw error;
		}
	});
}

export interface OwnedProcessGenerationObservation {
	expected: OwnedProcessIdentity;
	current: OwnedProcessIdentity | null | "unreadable";
}

// 一份完整进程表排除已退出世代；原生探针失败仍保留缺证，不能把历史 PID 逐个派生成 ps。
export async function observeOwnedProcessGenerations(
	identities: OwnedProcessIdentity[],
	darwinNativeProbePath?: string | null,
): Promise<OwnedProcessGenerationObservation[]> {
	if (identities.length === 0) return [];
	try {
		const { stdout } = await executeFile("ps", ["-axo", "pid=,stat=,lstart="], {
			timeout: 5_000,
			maxBuffer: 32 * 1024 * 1024,
			env: { ...process.env, LC_ALL: "C" },
		});
		const currentByPid = new Map<number, OwnedProcessIdentity>();
		let parsedProcessCount = 0;
		for (const line of stdout.split("\n")) {
			const match = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}(?:\s.*)?)$/);
			if (line.trim() && !match) throw new Error("完整进程表包含不可解析的身份行");
			if (match?.[2] && match[3]) {
				parsedProcessCount++;
				if (!/^[ZX]/.test(match[2]))
					currentByPid.set(Number(match[1]), { pid: Number(match[1]), startAndCommand: match[3].trim() });
			}
		}
		if (parsedProcessCount === 0) throw new Error("完整进程表未包含可解析的进程身份");
		const nativeCandidatePids = [
			...new Set(
				identities
					.filter((entry) => entry.nativeProcessGenerationIdentity !== undefined && currentByPid.has(entry.pid))
					.map((entry) => entry.pid),
			),
		];
		if (process.platform === "darwin" && darwinNativeProbePath && nativeCandidatePids.length > 0) {
			try {
				const result = await executeFile(darwinNativeProbePath, ["", "--snapshot"], {
					timeout: 5_000,
					maxBuffer: 32 * 1024 * 1024,
				});
				const snapshot = JSON.parse(result.stdout) as {
					processes: { pid: number; processUniqueIdentity?: string }[];
				};
				for (const row of snapshot.processes) {
					const current = currentByPid.get(row.pid);
					if (current && row.processUniqueIdentity && /^\d+$/.test(row.processUniqueIdentity))
						current.nativeProcessGenerationIdentity = `darwin_unique_process_id:${row.processUniqueIdentity}`;
				}
			} catch {
				/* 表中仍存在但缺少精确代际的进程不能取得退出或信号资格。 */
			}
		} else if (process.platform === "linux") {
			await Promise.all(
				nativeCandidatePids.map((pid) =>
					limitProcessIdentityQueries(async () => {
						try {
							const value = await readFile(`/proc/${pid}/stat`, "utf8");
							const ticks = value.slice(value.lastIndexOf(")") + 2).split(/\s+/)[19];
							const current = currentByPid.get(pid);
							if (ticks && current) current.nativeProcessGenerationIdentity = `linux:${ticks}`;
						} catch {
							/* 查询期间退出或暂时不可读，均保留表中的缺证身份。 */
						}
					}),
				),
			);
		}
		return identities.map((expected) => ({ expected, current: currentByPid.get(expected.pid) ?? null }));
	} catch {
		return identities.map((expected) => ({ expected, current: "unreadable" }));
	}
}

// 独立监督进程不加载 runtime 或插件依赖；启动材料、唯一 nonce 和进程身份均先落盘。
const supervisorSource = String.raw`
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { open, readFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const OWNED_COMMAND_EXECUTION_OWNERSHIP_ENVIRONMENT_KEY='KANBAN_OWNED_COMMAND_EXECUTION_NONCE';
async function readNativeProcessExecutionEnvironmentOwnership(pids,token) {
 if(process.platform==='darwin') {
  if(!materials.darwinOriginalParentGenerationProbePath)return new Map();
  try{return new Map(JSON.parse(execFileSync(materials.darwinOriginalParentGenerationProbePath,[token,...pids.map(String)],{encoding:'utf8',timeout:5000,maxBuffer:32*1024*1024})).map(entry=>[entry.pid,entry]));}catch{return new Map();}
 }
 if(process.platform!=='linux')return new Map();
 const observations=new Map();let nextIndex=0;
 await Promise.all(Array.from({length:Math.min(8,pids.length)},async()=>{while(nextIndex<pids.length){const pid=pids[nextIndex++];try{const environment=await readFile('/proc/'+pid+'/environ','utf8');observations.set(pid,{hasExecutionOwnershipToken:environment.split(String.fromCharCode(0)).includes('KANBAN_OWNED_COMMAND_EXECUTION_NONCE='+token)});}catch{observations.set(pid,{hasExecutionOwnershipToken:null});}}}));
 return observations;
}
const materialsFile = process.argv[2];
const materials = JSON.parse(await readFile(materialsFile, 'utf8'));
const directory = materials.directory;
const nonce = materials.launchNonce;
let businessDispatchSequenceNumber=0;
let outputTail = '';
let lastSavedProgress=null;
function captureOutput(chunk) { outputTail=(outputTail+chunk.toString('utf8')).slice(-materials.outputTailMaxChars); }
async function save(name, value, targetDirectory=directory) {
 if(name.startsWith('supervisor-progress-'))value={businessDispatchSequenceNumber,...value};
 if(materials.outputTailMaxChars && name.startsWith('supervisor-progress-'))value={...value,outputTail};
 let progressObservation=null;
 if(name.startsWith('supervisor-progress-')){
  const {updatedAtEpochMs,ownedProcesses,...semantic}=value;
  progressObservation={name,ownedProcesses,fingerprint:JSON.stringify(semantic)};
  if(lastSavedProgress?.name===name && lastSavedProgress.ownedProcesses===ownedProcesses && lastSavedProgress.fingerprint===progressObservation.fingerprint)return;
 }
 const target=join(targetDirectory,name); const staging=target+'.'+process.pid+'.pending';
 const handle=await open(staging,'w',0o600); await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); await rename(staging,target);
 if(process.platform!=='win32'){const directoryHandle=await open(targetDirectory,'r');try{await directoryHandle.sync();}finally{await directoryHandle.close();}}
 if(progressObservation)lastSavedProgress=progressObservation;
}
function nativeGeneration(pid) {
 if(!materials.superviseProcessGroup)return {};
 try {
  if(process.platform==='linux'){const value=readFileSync('/proc/'+pid+'/stat','utf8');const ticks=value.slice(value.lastIndexOf(')')+2).split(/\s+/)[19];return ticks?{nativeProcessGenerationIdentity:'linux:'+ticks,observedParentProcessPid:Number(value.slice(value.lastIndexOf(')')+2).split(/\s+/)[1]),observedProcessGroupPid:Number(value.slice(value.lastIndexOf(')')+2).split(/\s+/)[2])}:{};}
  if(materials.darwinOriginalParentGenerationProbePath){const row=JSON.parse(execFileSync(materials.darwinOriginalParentGenerationProbePath,['',String(pid)],{encoding:'utf8',timeout:5000}))[0];return row?.processUniqueIdentity?{nativeProcessGenerationIdentity:'darwin_unique_process_id:'+row.processUniqueIdentity}:{};}
 }catch{}return {};
}
function identity(pid) {
 try { if(materials.superviseProcessGroup && execFileSync('ps',['-p',String(pid),'-o','stat='],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore'],env:{...process.env,LC_ALL:'C'}}).trim().startsWith('Z'))return null; const value=execFileSync('ps',['-p',String(pid),'-o','lstart=','-o','command='],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore'],env:{...process.env,LC_ALL:'C'}}).trim(); return value ? {pid,startAndCommand:value,...nativeGeneration(pid)}:null; }
 catch(error) { if(error.status===1)return null; throw error; }
}
function hasSameProcessGeneration(current,expected) {
 if(!current || !expected || current.pid!==expected.pid)return false;
 if(materials.superviseProcessGroup && (!current.nativeProcessGenerationIdentity || !expected.nativeProcessGenerationIdentity))return false;
 if(expected.nativeProcessGenerationIdentity!==undefined)return current.nativeProcessGenerationIdentity===expected.nativeProcessGenerationIdentity;
 const processStartIdentity=entry=>entry.startAndCommand.match(/^\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}(?=\s|$)/)?.[0];
 const currentStart=processStartIdentity(current);return currentStart!==undefined && currentStart===processStartIdentity(expected);
}
async function revoked() { for(const path of [materials.revocationFile,materials.producerExecutionRevocationFile].filter(Boolean)){try { await readFile(path); return true; } catch(error) { if(error.code!=='ENOENT')throw error; }}return false; }
await mkdir(directory,{recursive:true});
const claimPath=join(directory,'supervisor-claim-'+nonce+'.json');
try { const claim=await open(claimPath,'wx',0o600); await claim.writeFile(JSON.stringify(identity(process.pid))); await claim.sync(); await claim.close(); }
catch(error) { if(error.code!=='EEXIST')throw error; const owner=JSON.parse(await readFile(claimPath,'utf8')); const current=identity(owner.pid); if(materials.preventRedispatch || hasSameProcessGeneration(current,owner)) { process.exitCode=0; } else { await unlink(claimPath); const claim=await open(claimPath,'wx',0o600); await claim.writeFile(JSON.stringify(identity(process.pid))); await claim.sync(); await claim.close(); } }
const owner=JSON.parse(await readFile(claimPath,'utf8'));
if(owner.pid===process.pid) {
 await save('supervisor-identity-'+nonce+'.json',{...identity(process.pid),launchNonce:nonce});
 let child=null; let cancelled=false; let timedOut=false; let cancellationStartedAtEpochMs=null; let nativeOwnershipUnproven=false; let unprovenOwnershipProcesses=[]; const owned=new Map();
 let ownedHistorySnapshot=[];let ownedHistoryChanged=false;let ownedHistoryRevision=0;let lastProcessSnapshot=new Map();
 function rememberOwned(entry){const prior=owned.get(entry.pid);if(hasSameProcessGeneration(entry,prior))return;owned.set(entry.pid,entry);ownedHistoryChanged=true;ownedHistoryRevision++;}
 function ownedProcessHistory(){if(ownedHistoryChanged){ownedHistorySnapshot=[...owned.values()];ownedHistoryChanged=false;}return ownedHistorySnapshot;}
 const beforeDispatchProcesses=new Map(); const unrelatedOriginalParentVersions=new Set();
 let pidNamespaceIdentity=null;
 const frozenDispatchAncestorPids=new Set(); const frozenBaselineDescendantPids=new Set(); let frozenDispatchAncestorEvidenceComplete=false;
 let linuxKernelContainmentAddon=null; let linuxKernelContainmentVerified=false; let linuxKernelContainmentContinuityLost=false; let containmentPreparationError=null;
 if(materials.linuxKernelChildSubreaperContainmentRequired) {
  try {
   pidNamespaceIdentity=readlinkSync('/proc/self/ns/pid');
   if(!materials.linuxKernelChildSubreaperContainmentAddonPath)throw new Error(materials.linuxKernelChildSubreaperContainmentUnavailabilityReason??'原生 addon 尚不可用');
   linuxKernelContainmentAddon=createRequire(materialsFile)(materials.linuxKernelChildSubreaperContainmentAddonPath);
   if(linuxKernelContainmentAddon.establish()!==1)throw new Error('PR_SET_CHILD_SUBREAPER/PR_GET_CHILD_SUBREAPER 未核验');
   linuxKernelContainmentVerified=true;
   await save('kernel-child-subreaper-containment-'+nonce+'.json',{launchNonce:nonce,systemBootIdentity:materials.systemBootIdentity,pidNamespaceIdentity,mode:'linux_child_subreaper_established_before_script_dispatch',...identity(process.pid),verifiedAtEpochMs:Date.now()});
  }catch(error){containmentPreparationError=String(error);cancelled=true;}
 }
 let nativeQueryFailureObservations=[];
 function readOriginalParentGenerations(entries) {
  if(!materials.darwinOriginalParentGenerationProbePath)return new Map();
  try {return new Map(JSON.parse(execFileSync(materials.darwinOriginalParentGenerationProbePath,['',...entries.map(entry=>String(entry.pid))],{encoding:'utf8',timeout:5000,maxBuffer:32*1024*1024})).map(entry=>[entry.pid,entry]));}catch(error){nativeQueryFailureObservations.push({query:'darwin_native_process_generations',pidCount:entries.length,code:error.code??null,status:error.status??null,signal:error.signal??null});nativeQueryFailureObservations=nativeQueryFailureObservations.slice(-3);return new Map();}
 }
 function readDarwinNativeProcessSnapshot() {
  if(!materials.darwinOriginalParentGenerationProbePath)throw new Error('Darwin 原生进程快照尚不可用');
  const snapshot=JSON.parse(execFileSync(materials.darwinOriginalParentGenerationProbePath,['','--snapshot'],{encoding:'utf8',timeout:5000,maxBuffer:32*1024*1024}));
  // snapshotComplete 汇总所有系统 PID 的原生精度；缺证逐行处理，不把无关 PID 缺证当作枚举失败。
  return snapshot.processes.filter(entry=>entry.pid!==snapshot.queryProcessPid).map(entry=>({...entry,parent:entry.parentProcessPid,startAndCommand:entry.processStartIdentity??'native process observation',...(entry.processUniqueIdentity?{nativeProcessGenerationIdentity:'darwin_unique_process_id:'+entry.processUniqueIdentity}:{})}));
 }
 function processEntries() {
  if(materials.superviseProcessGroup && process.platform==='darwin')return readDarwinNativeProcessSnapshot();
  const args=['-axo','pid=,ppid=,stat=,lstart=']; const opts={encoding:'utf8',timeout:5000,maxBuffer:32*1024*1024,env:{...process.env,LC_ALL:'C'}};
  const query=materials.superviseProcessGroup?spawnSync('ps',args,opts):null;
  if(query && query.status!==0)throw new Error('原生进程表暂不可读');
  const output=query?query.stdout:execFileSync('ps',args,opts);
  const rows=output.split('\n').filter(line=>line.trim());
  const matches=rows.map(line=>line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}(?:\s.*)?)$/));
  if(matches.some(match=>!match))throw new Error('完整进程表包含不可解析的身份行');
  const entries=matches.map(match=>({pid:Number(match[1]),parent:Number(match[2]),processIsZombie:/^[ZX]/.test(match[3]),startAndCommand:match[4].trim()})).filter(entry=>entry.pid!==query?.pid);
  if(entries.length===0)throw new Error('完整进程表未包含可解析的进程身份');
  if(materials.superviseProcessGroup && process.platform==='linux')return entries.map(entry=>{const native=nativeGeneration(entry.pid);return {...entry,...native,parent:native.observedParentProcessPid??entry.parent};});
  if(materials.superviseProcessGroup && materials.darwinOriginalParentGenerationProbePath){const versions=readOriginalParentGenerations(entries);return entries.map(entry=>({...entry,...(versions.get(entry.pid)?.processUniqueIdentity?{nativeProcessGenerationIdentity:'darwin_unique_process_id:'+versions.get(entry.pid).processUniqueIdentity}:{})}));}
  return entries;
 }
 function parentGeneration(entry) {
   if(!entry)return null;
   if(!entry.nativeProcessGenerationIdentity){try{if(process.platform==='linux'){readFileSync('/proc/'+entry.pid+'/stat','utf8');return null;}return identity(entry.pid)===null?{absent:true}:null;}catch(error){return error.code==='ENOENT'?{absent:true}:null;}}
   try {
    if(process.platform==='linux'){const value=readFileSync('/proc/'+entry.pid+'/stat','utf8');const fields=value.slice(value.lastIndexOf(')')+2).split(/\s+/);return {parent:Number(fields[1]),generation:'linux:'+fields[19]};}
    const row=readOriginalParentGenerations([entry]).get(entry.pid);return row?{parent:row.parentProcessPid,generation:'darwin_unique_process_id:'+row.processUniqueIdentity}:identity(entry.pid)===null?{absent:true}:null;
   }catch(error){return error.code==='ENOENT'?{absent:true}:null;}
  }
 function captureBeforeDispatchBaseline() {
  beforeDispatchProcesses.clear();unrelatedOriginalParentVersions.clear();frozenDispatchAncestorPids.clear();frozenBaselineDescendantPids.clear();
  const baseline=processEntries();const byPid=new Map(baseline.map(entry=>[entry.pid,entry]));for(const entry of baseline)beforeDispatchProcesses.set(entry.pid,entry);
  let ancestor=process.pid;frozenDispatchAncestorEvidenceComplete=false;
  while(!frozenDispatchAncestorPids.has(ancestor)) {
   const entry=byPid.get(ancestor);if(!entry)break;const current=parentGeneration(entry);
   if(!current||current.generation!==entry.nativeProcessGenerationIdentity||current.parent!==entry.parent)break;
   frozenDispatchAncestorPids.add(ancestor);if(ancestor===1||current.parent===0){frozenDispatchAncestorEvidenceComplete=true;break;}ancestor=current.parent;
  }
  frozenBaselineDescendantPids.add(process.pid);let added=true;
  while(added){added=false;for(const entry of baseline)if(frozenBaselineDescendantPids.has(entry.parent)&&!frozenBaselineDescendantPids.has(entry.pid)){frozenBaselineDescendantPids.add(entry.pid);added=true;}}
  for(const entry of readOriginalParentGenerations(baseline).values())if(!frozenBaselineDescendantPids.has(entry.pid))unrelatedOriginalParentVersions.add(entry.processIdVersion);
  return {launchNonce:nonce,systemBootIdentity:materials.systemBootIdentity,pidNamespaceIdentity,capturedAtEpochMs:Date.now(),ancestorEvidenceComplete:frozenDispatchAncestorEvidenceComplete,ancestorProcesses:baseline.filter(entry=>frozenDispatchAncestorPids.has(entry.pid)).map(({pid,parent,nativeProcessGenerationIdentity})=>({pid,parent,nativeProcessGenerationIdentity})),baselineDescendantProcesses:baseline.filter(entry=>frozenBaselineDescendantPids.has(entry.pid)).map(({pid,parent,nativeProcessGenerationIdentity})=>({pid,parent,nativeProcessGenerationIdentity}))};
 }
 function readProcessGroupSnapshot() {
  try {
   const query=spawnSync('ps',['-axo','pid=,pgid=,stat='],{encoding:'utf8',timeout:5000,maxBuffer:32*1024*1024});
   if(query.status!==0)throw Object.assign(new Error('原生进程组表暂不可读'),{status:query.status,code:query.error?.code});
   const processGroupSnapshotMatches=query.stdout.split('\n').filter(line=>line.trim()).map(line=>line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/));
   if(processGroupSnapshotMatches.some(match=>!match)||!processGroupSnapshotMatches.some(match=>Number(match?.[1])===process.pid))throw new Error('完整进程组表缺少可核验的监管器身份或包含不可解析的行');
   return processGroupSnapshotMatches.map(match=>({pid:Number(match[1]),processGroupPid:Number(match[2]),processIsZombie:/^[ZX]/.test(match[3])})).filter(entry=>entry.pid!==query.pid);
  }
  catch(error){throw Object.assign(error,{processSnapshotQuery:'process_group_snapshot'});}
 }
 async function collect(allowImmediateLateProcessAbsenceSubtreeRescan=true) {
  nativeQueryFailureObservations=[];
  let entries=processEntries();
  if(!child?.pid){lastProcessSnapshot=new Map(entries.filter(entry=>entry.pid===process.pid && !entry.processIsZombie).map(entry=>[entry.pid,entry]));nativeOwnershipUnproven=false;unprovenOwnershipProcesses=[];return [];}
  const unprovenOwnershipPids=new Set(); const unprovenOwnershipReasons=new Map(); const originalParentGenerationByPid=new Map();
  nativeOwnershipUnproven=false;let currentDarwinParentGenerations=new Map();
  function currentParentGeneration(entry){if(!entry)return null;if(process.platform!=='darwin')return parentGeneration(entry);const row=currentDarwinParentGenerations.get(entry.pid);return row?.processUniqueIdentity?{parent:row.parentProcessPid,generation:'darwin_unique_process_id:'+row.processUniqueIdentity}:null;}
  function independentBaselineDescendants(snapshot) {
   if(!frozenDispatchAncestorEvidenceComplete)return new Set();
   const ancestors=new Set([...frozenDispatchAncestorPids,...frozenBaselineDescendantPids]);
   const expiredIndependentObservations=new Set();
   const unrelated=new Set(snapshot.filter(entry=>!ancestors.has(entry.pid)&&entry.nativeProcessGenerationIdentity&&hasSameProcessGeneration(entry,beforeDispatchProcesses.get(entry.pid))&&currentParentGeneration(entry)?.generation===entry.nativeProcessGenerationIdentity).map(entry=>entry.pid));
   let added=true;while(added){added=false;for(const entry of snapshot)if(!unrelated.has(entry.pid)&&!ancestors.has(entry.pid)&&!hasSameProcessGeneration(entry,owned.get(entry.pid))&&unrelated.has(entry.parent)) {
    const current=currentParentGeneration(entry);const parent=snapshot.find(candidate=>candidate.pid===entry.parent);const currentParent=currentParentGeneration(parent);
    if(current?.absent){expiredIndependentObservations.add(entry.pid);}
    else if(current && current.generation===entry.nativeProcessGenerationIdentity && current.parent===entry.parent && currentParent?.generation===parent?.nativeProcessGenerationIdentity && parent?.nativeProcessGenerationIdentity){unrelated.add(entry.pid);added=true;}
   }}
   return new Set([...unrelated,...expiredIndependentObservations]);
  }
  if(materials.superviseProcessGroup) {
   const candidates=entries.filter(entry=>entry.pid!==process.pid && !hasSameProcessGeneration(entry,beforeDispatchProcesses.get(entry.pid)));
   try {
    const environments=await readNativeProcessExecutionEnvironmentOwnership(candidates.map(entry=>entry.pid),nonce);
    const previousEntries=new Map(entries.map(entry=>[entry.pid,entry])); entries=processEntries();
    currentDarwinParentGenerations=readOriginalParentGenerations(entries);
    const independentDescendants=independentBaselineDescendants(entries);
    const nativeGenerations=new Map(entries.filter(entry=>entry.nativeProcessGenerationIdentity && entry.originalParentProcessIdVersion!==undefined).map(entry=>[entry.pid,entry]));for(const [pid,row] of currentDarwinParentGenerations)if(row.processUniqueIdentity)nativeGenerations.set(pid,row); for(const native of nativeGenerations.values())originalParentGenerationByPid.set(native.pid,native.originalParentProcessIdVersion); const unrelatedPids=new Set(); let unrelatedAdded=true;
    while(unrelatedAdded){unrelatedAdded=false;for(const entry of nativeGenerations.values())if(entry.pid!==process.pid&&!unrelatedPids.has(entry.pid)&&unrelatedOriginalParentVersions.has(entry.originalParentProcessIdVersion)){unrelatedPids.add(entry.pid);unrelatedOriginalParentVersions.add(entry.processIdVersion);unrelatedAdded=true;}}
    for(const entry of entries){
     if(entry.pid===process.pid || hasSameProcessGeneration(entry,beforeDispatchProcesses.get(entry.pid)))continue;
     const origin=hasSameProcessGeneration(entry,previousEntries.get(entry.pid))?environments.get(entry.pid):undefined;
     if(origin?.hasExecutionOwnershipToken===true && entry.nativeProcessGenerationIdentity)rememberOwned({pid:entry.pid,startAndCommand:entry.startAndCommand,nativeProcessGenerationIdentity:entry.nativeProcessGenerationIdentity});
     else if(!independentDescendants.has(entry.pid)&&!unrelatedPids.has(entry.pid) && !hasSameProcessGeneration(entry,owned.get(entry.pid)) && !origin?.outsideCurrentUser && !origin?.launchedByServiceManager){unprovenOwnershipPids.add(entry.pid);unprovenOwnershipReasons.set(entry.pid,origin?.hasExecutionOwnershipToken===false?'original_parent_lineage_not_proven':'native_environment_or_process_generation_unavailable');}
    }
   } catch { unprovenOwnershipPids.add(-1); }
  }
  let lateProcessAbsenceRequiresSubtreeRescan=false;
  const groupMembers=new Set(); const lateNativeSnapshotPids=new Set(); const zombies=new Set(entries.filter(entry=>entry.processIsZombie).map(entry=>entry.pid));
  if(materials.superviseProcessGroup) {
   // Linux 已从同一份 /proc stat 读取代际与 PGID，保留双快照核验而不再派生第三次 ps。
   if(process.platform==='linux'){for(const entry of entries)if(entry.observedProcessGroupPid===process.pid && entry.pid!==process.pid && !entry.processIsZombie)groupMembers.add(entry.pid);}
   else {
    const processGroupSnapshot=readProcessGroupSnapshot();const currentProcessGroupSnapshotPids=new Set(processGroupSnapshot.map(entry=>entry.pid));
    // 原生枚举后已退出的 PID 由随后完整 ps 进程表补证；表内缺精度进程继续保持未知。
    entries=entries.filter(entry=>currentProcessGroupSnapshotPids.has(entry.pid));
    for(const pid of unprovenOwnershipPids)if(pid>0&&!currentProcessGroupSnapshotPids.has(pid))unprovenOwnershipPids.delete(pid);
    // 对固定的一批迟到 PID 补查原生身份，避免整机持续新建进程让整表刷新永远追不上。
    const nativeSnapshotPids=new Set(entries.map(entry=>entry.pid));
    const lateProcessRows=processGroupSnapshot.filter(entry=>!entry.processIsZombie&&!nativeSnapshotPids.has(entry.pid));
    const lateNativeObservations=lateProcessRows.length?await readNativeProcessExecutionEnvironmentOwnership(lateProcessRows.map(entry=>entry.pid),nonce):new Map();
    let unrelatedAdded=true;while(unrelatedAdded){unrelatedAdded=false;for(const native of lateNativeObservations.values())if(native.processUniqueIdentity&&native.hasExecutionOwnershipToken!==true&&unrelatedOriginalParentVersions.has(native.originalParentProcessIdVersion)&&!unrelatedOriginalParentVersions.has(native.processIdVersion)){unrelatedOriginalParentVersions.add(native.processIdVersion);unrelatedAdded=true;}}
    for(const row of lateProcessRows){
     lateNativeSnapshotPids.add(row.pid);
     const native=lateNativeObservations.get(row.pid);
     // PID 消失不能排除其后代；完整补查只立即执行一次，再遇竞态仍保留未知并走既有恢复预算。
     if(native?.nativeProcessNoLongerExists===true&&allowImmediateLateProcessAbsenceSubtreeRescan){lateProcessAbsenceRequiresSubtreeRescan=true;continue;}
     const entry={...row,...native,parent:native?.parentProcessPid??-1,startAndCommand:native?.processStartIdentity??'unavailable',...(native?.processUniqueIdentity?{nativeProcessGenerationIdentity:'darwin_unique_process_id:'+native.processUniqueIdentity}:{})};
     entries.push(entry);
     if(native?.processIsZombie)zombies.add(row.pid);
     if(native){currentDarwinParentGenerations.set(row.pid,native);originalParentGenerationByPid.set(row.pid,native.originalParentProcessIdVersion);}
     if(native?.hasExecutionOwnershipToken===true&&entry.nativeProcessGenerationIdentity)rememberOwned(entry);
     else if(!native?.outsideCurrentUser&&!hasSameProcessGeneration(entry,beforeDispatchProcesses.get(row.pid))&&!(entry.nativeProcessGenerationIdentity&&unrelatedOriginalParentVersions.has(native?.originalParentProcessIdVersion))){unprovenOwnershipPids.add(row.pid);unprovenOwnershipReasons.set(row.pid,'current_process_missing_from_native_snapshot');}
    }
    // 迟到行的原生代际晚于 ps；旧组/父关系不授予新代际归属，nonce 或后续完整快照仍可补证。
    for(const entry of processGroupSnapshot)if(entry.processIsZombie)zombies.add(entry.pid);else if(entry.processGroupPid===process.pid && entry.pid!==process.pid&&!lateNativeSnapshotPids.has(entry.pid))groupMembers.add(entry.pid);
   }
  }
  if(lateProcessAbsenceRequiresSubtreeRescan)return collect(false);
  const parents=new Set(entries.filter(entry=>!zombies.has(entry.pid)&&(groupMembers.has(entry.pid)||hasSameProcessGeneration(entry,owned.get(entry.pid)))).map(entry=>entry.pid)); if(linuxKernelContainmentVerified&&!linuxKernelContainmentContinuityLost)parents.add(process.pid); let changed=true;
  while(changed){changed=false;for(const entry of entries)if(entry.pid!==process.pid && !lateNativeSnapshotPids.has(entry.pid) && parents.has(entry.parent)&&!parents.has(entry.pid)){const parent=entries.find(candidate=>candidate.pid===entry.parent);const current=currentParentGeneration(entry);const currentParent=currentParentGeneration(parent);if(!materials.superviseProcessGroup || (current?.generation===entry.nativeProcessGenerationIdentity && current?.parent===entry.parent && currentParent?.generation===parent?.nativeProcessGenerationIdentity && entry.nativeProcessGenerationIdentity && parent?.nativeProcessGenerationIdentity)){parents.add(entry.pid);changed=true;}}}
  for(const entry of entries)if(entry.pid!==process.pid&&parents.has(entry.pid)&&(!materials.superviseProcessGroup||entry.nativeProcessGenerationIdentity))rememberOwned({pid:entry.pid,startAndCommand:entry.startAndCommand,...(entry.nativeProcessGenerationIdentity?{nativeProcessGenerationIdentity:entry.nativeProcessGenerationIdentity}:{})});
  for(const entry of entries)if(materials.superviseProcessGroup && parents.has(entry.pid)&&!entry.nativeProcessGenerationIdentity){unprovenOwnershipPids.add(entry.pid);unprovenOwnershipReasons.set(entry.pid,'precise_native_process_generation_unavailable');}
  if(linuxKernelContainmentVerified&&!linuxKernelContainmentContinuityLost)for(const pid of [...unprovenOwnershipPids])if(!parents.has(pid)&&!hasSameProcessGeneration(entries.find(entry=>entry.pid===pid),owned.get(pid)))unprovenOwnershipPids.delete(pid);
  nativeOwnershipUnproven=[...unprovenOwnershipPids].some(pid=>!zombies.has(pid)&&(!parents.has(pid)||unprovenOwnershipReasons.get(pid)==='precise_native_process_generation_unavailable'));
  unprovenOwnershipProcesses=entries.filter(entry=>unprovenOwnershipPids.has(entry.pid)&&!zombies.has(entry.pid)&&(!parents.has(entry.pid)||unprovenOwnershipReasons.get(entry.pid)==='precise_native_process_generation_unavailable')).map(entry=>({pid:entry.pid,parentProcessPid:entry.parent,processStartIdentity:entry.startAndCommand.match(/^\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}/)?.[0]??'unreadable',nativeProcessGenerationIdentity:entry.nativeProcessGenerationIdentity,originalParentProcessGenerationIdentity:originalParentGenerationByPid.has(entry.pid)?'darwin_parent_id_version:'+originalParentGenerationByPid.get(entry.pid):undefined,reason:unprovenOwnershipReasons.get(entry.pid)??'native_process_snapshot_incomplete'}));
  lastProcessSnapshot=new Map(entries.filter(entry=>!zombies.has(entry.pid)).map(entry=>[entry.pid,entry]));
  return entries.filter(entry=>!zombies.has(entry.pid)&&hasSameProcessGeneration(entry,owned.get(entry.pid)));
 }
 let postScriptOwnershipRecoveryBudget={evidenceFingerprint:'',unchangedEvidenceProbeCount:0,nextActiveProbeAtEpochMs:0};
 let postScriptOwnershipRecoveryWaiting=false;let lastPassiveProcessEvidenceFingerprint=null;
 let nextPassiveProcessEvidenceObservationAtEpochMs=0;
 const postScriptRecoveryBudgetFile='post-script-ownership-recovery-budget-'+nonce+'.json';
 const postScriptRecoveryEvidenceFingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 function postScriptOwnershipSemanticEvidence(settled){return {settled,cancelled,timedOut,ownedHistoryRevision,unproven:unprovenOwnershipProcesses.map(entry=>[entry.pid,entry.nativeProcessGenerationIdentity??null,entry.originalParentProcessGenerationIdentity??null,entry.reason]).sort((a,b)=>a[0]-b[0])};}
 function observeKnownPostScriptProcessEvidence(){
  const entries=[...new Map([...lastProcessSnapshot.values()].filter(entry=>owned.has(entry.pid)).concat(unprovenOwnershipProcesses).map(entry=>[entry.pid,entry])).values()];
  const native=process.platform==='darwin'?readOriginalParentGenerations(entries):new Map();
  const snapshotAvailability=[];
  for(const query of ['complete_process_snapshot','process_group_snapshot'])if(nativeQueryFailureObservations.some(entry=>entry.query===query)){try{if(query==='process_group_snapshot')readProcessGroupSnapshot();else processEntries();snapshotAvailability.push([query,'available']);}catch{snapshotAvailability.push([query,'unreadable']);}}
  return postScriptRecoveryEvidenceFingerprint({snapshotAvailability,processes:entries.map(entry=>{const current=process.platform==='darwin'?native.get(entry.pid):nativeGeneration(entry.pid);return [entry.pid,current?.processUniqueIdentity??current?.nativeProcessGenerationIdentity??null,current?.originalParentProcessIdVersion??null,current?.parentProcessPid??current?.observedParentProcessPid??null];}).sort((a,b)=>a[0]-b[0])});
 }
 async function savePostScriptRecoveryBudget(){await save(postScriptRecoveryBudgetFile,{launchNonce:nonce,...postScriptOwnershipRecoveryBudget,lastPassiveProcessEvidenceFingerprint});}
 function terminate() {
  cancelled=true;
  cancellationStartedAtEpochMs ??= Date.now();
  const signal=Date.now()-cancellationStartedAtEpochMs>=1000?'SIGKILL':'SIGTERM';
  for(const observed of [...lastProcessSnapshot.values()].reverse()) { const entry=owned.get(observed.pid);if(!hasSameProcessGeneration(observed,entry))continue;try{const current=identity(entry.pid);if(!current || (current.nativeProcessGenerationIdentity && !hasSameProcessGeneration(current,entry)))lastProcessSnapshot.delete(entry.pid);if(hasSameProcessGeneration(current,entry)) { try { process.kill(entry.pid,signal); }catch{} }}catch{nativeOwnershipUnproven=true;} }
 }
 process.on('SIGTERM',terminate); process.on('SIGINT',terminate);
 async function launchPostProcessExitCleanup() {
  if(!materials.postProcessExitCleanupCommand||nativeOwnershipUnproven||businessDispatchSequenceNumber===0)return;
  const cleanupDirectory=join(directory,'post-process-exit-cleanup',nonce,'dispatch-'+businessDispatchSequenceNumber);await mkdir(cleanupDirectory,{recursive:true});
  try{const progress=JSON.parse(await readFile(join(cleanupDirectory,'supervisor-progress-'+nonce+'.json'),'utf8'));if(progress.status==='exited'&&progress.returncode===0&&!progress.timedOut)return;}catch{}
  try{const owner=JSON.parse(await readFile(join(cleanupDirectory,'supervisor-identity-'+nonce+'.json'),'utf8'));if(hasSameProcessGeneration(identity(owner.pid),owner))return;}catch{}
  try{for(const stream of ['stdout','stderr']){const original=await open(join(directory,'command-'+nonce+'.'+stream+'.txt'),'r+');try{await original.sync();}finally{await original.close();}}}catch(error){try{await save('post-process-exit-cleanup-pending-'+nonce+'.json',{status:'evidence_pending',error:String(error)});}catch{}return;}
  const confirmationName='post-process-exit-cleanup-confirmation-'+nonce+'-dispatch-'+businessDispatchSequenceNumber+'.json';
  const confirmation=join(directory,confirmationName);
  try{await readFile(confirmation);}catch(error){if(error.code!=='ENOENT')throw error;await save(confirmationName,{schemaVersion:1,executionId:materials.executionId,launchNonce:nonce,businessDispatchSequenceNumber,materialSha256:materials.materialSha256,command:materials.command,systemBootIdentity:materials.systemBootIdentity,ownedProcessesExited:true,originalOutputDurablySaved:true,confirmedAtEpochMs:Date.now()});}
  const cleanupMaterials={...materials,directory:cleanupDirectory,command:materials.postProcessExitCleanupCommand,isRecoveryLaunch:false,semanticRecovery:null,postProcessExitCleanupCommand:null,producerExecutionRevocationFile:null,revocationFile:join(cleanupDirectory,'cleanup-revocation.json'),deadlineAtEpochMs:Date.now()+300000,environment:{...materials.environment,KANBAN_COMMAND_EXECUTION_EXIT_CONFIRMATION_FILE:confirmation}};
  const cleanupMaterialsFile=join(cleanupDirectory,'launch-materials-'+nonce+'.json');
  await save('launch-materials-'+nonce+'.json',cleanupMaterials,cleanupDirectory);
  await save('supervisor-spawn-dispatch-barrier-'+nonce+'.json',{launchNonce:nonce,phase:'supervisor_spawn_may_start'},cleanupDirectory);
  const log=await open(join(cleanupDirectory,'supervisor-'+nonce+'.log'),'a',0o600);
  try{const cleanup=spawn(process.execPath,[process.argv[1],cleanupMaterialsFile],{cwd:materials.workingDirectory,detached:true,stdio:['ignore',log.fd,log.fd],env:{...process.env,...materials.environment}});cleanup.unref();}finally{await log.close();}
 }
 let persistSemanticResumeDispatchBudget=null;
 async function waitForSemanticBusinessRecovery(permitResumeWithoutBusinessResult=false) {
  if(!materials.semanticRecovery)return false;
  let result;try{result=JSON.parse(await readFile(materials.semanticRecovery.resultFile,'utf8'));}catch(error){return permitResumeWithoutBusinessResult&&error.code==='ENOENT';}
  if(result.disposition!=='machine_evidence_pending'||result.recovery?.action!=='resume_same_run')return false;
  const interval=materials.semanticRecoveryObservationIntervalMs??30000;
  const budgetName='semantic-business-recovery-attempt-budgets.json';
  let persisted;try{persisted=JSON.parse(await readFile(join(directory,budgetName),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(persisted&&persisted.materialSha256!==materials.semanticRecovery.materialSha256)throw new Error('恢复预算与冻结命令材料不匹配');
  const budgets=persisted?.budgets??{};let baselineEvidence=persisted?.baselineEvidence??null;let semanticRecoveryObservationCount=0;
  while(!cancelled&&!timedOut&&!await revoked()) {
   await launchPostProcessExitCleanup();
   semanticRecoveryObservationCount++;
   const observed=spawnSync(materials.semanticRecovery.observationCommand[0],materials.semanticRecovery.observationCommand.slice(1),{cwd:materials.workingDirectory,encoding:'utf8',timeout:15000,maxBuffer:1048576,stdio:['ignore','pipe','ignore']});
   let fingerprint;let recoveryEvidenceReady=false;try{if(observed.status===0){const observation=JSON.parse(observed.stdout);if(/^[a-f0-9]{64}$/.test(observation.evidenceSha256)){fingerprint=observation.evidenceSha256;recoveryEvidenceReady=observation.recoveryEvidenceReady===true;}}}catch{}
   const maximumUnchangedRetries=typeof result.recovery.maximum_unchanged_retries==='number'?Math.max(0,Math.min(3,Math.floor(result.recovery.maximum_unchanged_retries))):1;
   if(fingerprint&&!budgets[fingerprint])budgets[fingerprint]={resumeAttemptsUsed:0,includesEvidenceTransitionLaunch:baselineEvidence!==null&&baselineEvidence!==fingerprint};
   if(fingerprint&&baselineEvidence===null)baselineEvidence=fingerprint;
   const budget=fingerprint?budgets[fingerprint]:null;
   const maximumResumeAttempts=budget?Math.min(3,maximumUnchangedRetries+(budget.includesEvidenceTransitionLaunch?1:0)):0;
   await save(budgetName,{materialSha256:materials.semanticRecovery.materialSha256,baselineEvidence,budgets});
   await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:'machine_evidence_pending',ownedProcesses:[],businessDispatchQuiescent:true,semanticRecoveryObservationCount,semanticRecoveryEvidenceSha256:fingerprint??null,semanticRecoveryBudget:budget,maximumResumeAttempts,updatedAtEpochMs:Date.now()});
   if(cancelled||await revoked()){cancelled=true;return false;}
   if(materials.deadlineAtEpochMs&&Date.now()>=materials.deadlineAtEpochMs){timedOut=true;return false;}
   if(budget&&budget.resumeAttemptsUsed<maximumResumeAttempts&&Date.now()>=(result.recovery.retry_not_before_epoch_ms??0)&&(result.recovery.require_ready_recovery_evidence!==true||recoveryEvidenceReady)) {
    const validation=spawnSync(materials.semanticRecovery.validationCommand[0],materials.semanticRecovery.validationCommand.slice(1),{cwd:materials.workingDirectory,timeout:15000,maxBuffer:1048576,stdio:'ignore'});
    if(validation.status===0&&!cancelled&&!await revoked()) {
     persistSemanticResumeDispatchBudget=async()=>{
      budget.resumeAttemptsUsed++;
      await save(budgetName,{materialSha256:materials.semanticRecovery.materialSha256,baselineEvidence,budgets});
     };
     materials.command=materials.semanticRecovery.resumeCommand;
     return true;
    }
   }
   await new Promise(resolve=>setTimeout(resolve,interval));
  }
  cancelled=cancelled||await revoked();return false;
 }
 if(materials.superviseProcessGroup) {
  let ownIdentity=identity(process.pid);
  while(!ownIdentity?.nativeProcessGenerationIdentity && !await revoked() && Date.now()<materials.deadlineAtEpochMs) {
   await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:'running',nativeOwnershipUnproven:true,unprovenOwnershipProcesses:[{pid:process.pid,processStartIdentity:'unavailable',reason:'supervisor_precise_native_process_generation_unavailable_before_dispatch'}],ownedProcesses:[],updatedAtEpochMs:Date.now()});
   await new Promise(resolve=>setTimeout(resolve,200));ownIdentity=identity(process.pid);
  }
  if(ownIdentity?.nativeProcessGenerationIdentity){await save('supervisor-identity-'+nonce+'.json',{...ownIdentity,launchNonce:nonce});await save('dispatch-before-process-ancestry-'+nonce+'.json',captureBeforeDispatchBaseline());}
 }
 const initialBusinessDispatchPermitted=!materials.semanticRecovery||!materials.isRecoveryLaunch||await waitForSemanticBusinessRecovery(true);
 let dispatchAgain=initialBusinessDispatchPermitted;
 while(dispatchAgain) {
 if(materials.deadlineAtEpochMs && Date.now()>=materials.deadlineAtEpochMs)timedOut=true;
 if(!timedOut && !cancelled && !await revoked()) {
  businessDispatchSequenceNumber++;
  await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:'dispatch_committed',ownedProcesses:[],dispatchCommittedAtEpochMs:Date.now(),updatedAtEpochMs:Date.now()});
  if(persistSemanticResumeDispatchBudget){await persistSemanticResumeDispatchBudget();persistSemanticResumeDispatchBudget=null;}
  const stdout=await open(join(directory,'command-'+nonce+'.stdout.txt'),'a',0o600); const stderr=await open(join(directory,'command-'+nonce+'.stderr.txt'),'a',0o600);
  child=spawn(materials.command[0],materials.command.slice(1),{cwd:materials.workingDirectory,env:{...process.env,...materials.environment,...(materials.superviseProcessGroup?{NODE_OPTIONS:materials.commandNodeOptions??undefined}:{}),...(materials.superviseProcessGroup?{[OWNED_COMMAND_EXECUTION_OWNERSHIP_ENVIRONMENT_KEY]:nonce}:{}),KANBAN_COMMAND_EXECUTION_ID:materials.executionId,KANBAN_COMMAND_EXECUTION_REVOCATION_FILE:materials.revocationFile},detached:!materials.superviseProcessGroup,stdio:materials.outputTailMaxChars?['ignore','pipe','pipe']:['ignore',stdout.fd,stderr.fd]});
  if(materials.outputTailMaxChars){child.stdout?.on('data',captureOutput);child.stderr?.on('data',captureOutput);}
  const completion=new Promise(resolve=>{child.once('error',error=>resolve({error:String(error),returncode:null}));child.once('exit',(code,signal)=>resolve({returncode:code,signal}));});
  if(child.pid) { const childIdentity=identity(child.pid); if(childIdentity && (!materials.superviseProcessGroup || childIdentity.nativeProcessGenerationIdentity)){rememberOwned(childIdentity);lastProcessSnapshot.set(child.pid,childIdentity);} }
  await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:'running',ownedProcesses:ownedProcessHistory(),updatedAtEpochMs:Date.now()});
  await stdout.close();await stderr.close();
  let settled=null;let kernelChildExitObservation=null;void completion.then(value=>{settled=value;});
  while(true) {
   if(postScriptOwnershipRecoveryWaiting) {
    if(materials.deadlineAtEpochMs && Date.now()>=materials.deadlineAtEpochMs)timedOut=true;
    if(cancelled||timedOut||await revoked())terminate();
    const semanticFingerprint=postScriptRecoveryEvidenceFingerprint(postScriptOwnershipSemanticEvidence(settled));
    if(semanticFingerprint===postScriptOwnershipRecoveryBudget.evidenceFingerprint && Date.now()<nextPassiveProcessEvidenceObservationAtEpochMs){await new Promise(resolve=>setTimeout(resolve,200));continue;}
    nextPassiveProcessEvidenceObservationAtEpochMs=Date.now()+15000;
    const passiveFingerprint=observeKnownPostScriptProcessEvidence();
    if(semanticFingerprint!==postScriptOwnershipRecoveryBudget.evidenceFingerprint || passiveFingerprint!==lastPassiveProcessEvidenceFingerprint){postScriptOwnershipRecoveryBudget={evidenceFingerprint:semanticFingerprint,unchangedEvidenceProbeCount:0,nextActiveProbeAtEpochMs:0};lastPassiveProcessEvidenceFingerprint=passiveFingerprint;await savePostScriptRecoveryBudget();}
    if(postScriptOwnershipRecoveryBudget.unchangedEvidenceProbeCount>=3 || Date.now()<postScriptOwnershipRecoveryBudget.nextActiveProbeAtEpochMs) {
     await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:cancelled?'cancelling':'running',...settled,timedOut,nativeOwnershipUnproven,unprovenOwnershipProcesses,ownedProcesses:ownedProcessHistory(),postScriptOwnershipRecoveryBudget,nativeQueryFailureObservations,updatedAtEpochMs:Date.now()});
     const delayUntilEvidenceObservation=Date.now()<materials.deadlineAtEpochMs?Math.min(15000,Math.max(1,materials.deadlineAtEpochMs-Date.now())):15000;
     await new Promise(resolve=>setTimeout(resolve,Math.min(200,delayUntilEvidenceObservation)));continue;
    }
    postScriptOwnershipRecoveryBudget.unchangedEvidenceProbeCount++;postScriptOwnershipRecoveryBudget.nextActiveProbeAtEpochMs=Date.now()+15000;await savePostScriptRecoveryBudget();
   }
   let liveOwnedSnapshot=[];
   try{liveOwnedSnapshot=await collect();}catch(error){const query=error.processSnapshotQuery??'complete_process_snapshot';nativeOwnershipUnproven=true;unprovenOwnershipProcesses=[{pid:process.pid,processStartIdentity:'unavailable',reason:query+'_unavailable'}];nativeQueryFailureObservations=[{query,code:error.code??null,status:error.status??null}];}
   if(materials.superviseProcessGroup && !lastProcessSnapshot.get(process.pid)?.nativeProcessGenerationIdentity) {
    nativeOwnershipUnproven=true;
    unprovenOwnershipProcesses.push({pid:process.pid,processStartIdentity:'unavailable',reason:'supervisor_precise_native_process_generation_unavailable'});
   } if(materials.deadlineAtEpochMs && Date.now()>=materials.deadlineAtEpochMs)timedOut=true;
   if(cancelled || timedOut || await revoked())terminate();
   if(materials.superviseProcessGroup)for(const current of lastProcessSnapshot.values()){const entry=owned.get(current.pid);if(entry && (!entry.nativeProcessGenerationIdentity || !current.nativeProcessGenerationIdentity)){nativeOwnershipUnproven=true;unprovenOwnershipProcesses.push({pid:entry.pid,processStartIdentity:'unavailable',reason:'owned_precise_native_process_generation_unavailable'});}}
   kernelChildExitObservation=null;
   if(materials.linuxKernelChildSubreaperContainmentRequired) {
    try {
     if(!linuxKernelContainmentVerified||linuxKernelContainmentAddon.observe()!==1)linuxKernelContainmentContinuityLost=true;
     if(settled!==null&&!linuxKernelContainmentContinuityLost)kernelChildExitObservation=linuxKernelContainmentAddon.reapAndObserve();
     if(linuxKernelContainmentContinuityLost||kernelChildExitObservation<0){nativeOwnershipUnproven=true;unprovenOwnershipProcesses.push({pid:process.pid,processStartIdentity:'unavailable',nativeProcessGenerationIdentity:identity(process.pid)?.nativeProcessGenerationIdentity,reason:linuxKernelContainmentContinuityLost?'linux_kernel_child_subreaper_containment_continuity_unproven':'linux_kernel_descendant_wait_observation_failed'});}
    }catch{linuxKernelContainmentContinuityLost=true;nativeOwnershipUnproven=true;unprovenOwnershipProcesses.push({pid:process.pid,processStartIdentity:'unavailable',reason:'linux_kernel_child_subreaper_containment_observation_unavailable'});}
   }
   if(settled!==null && (!materials.linuxKernelChildSubreaperContainmentRequired||kernelChildExitObservation===0) && !nativeOwnershipUnproven && !liveOwnedSnapshot?.length)break;
   const waitingForUnprovenOwnershipOnly=settled!==null && nativeOwnershipUnproven && liveOwnedSnapshot?.length===0;
   if(waitingForUnprovenOwnershipOnly) {
    const semanticFingerprint=postScriptRecoveryEvidenceFingerprint(postScriptOwnershipSemanticEvidence(settled));
    if(!postScriptOwnershipRecoveryWaiting || postScriptOwnershipRecoveryBudget.evidenceFingerprint!==semanticFingerprint){postScriptOwnershipRecoveryBudget={evidenceFingerprint:semanticFingerprint,unchangedEvidenceProbeCount:0,nextActiveProbeAtEpochMs:Date.now()};lastPassiveProcessEvidenceFingerprint=observeKnownPostScriptProcessEvidence();await savePostScriptRecoveryBudget();}
   }
   postScriptOwnershipRecoveryWaiting=waitingForUnprovenOwnershipOnly;
   await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:cancelled?'cancelling':'running',...settled,timedOut,kernelChildExitObservation,linuxKernelContainmentVerified,linuxKernelContainmentContinuityLost,nativeOwnershipUnproven,unprovenOwnershipProcesses,ownedProcesses:ownedProcessHistory(),postScriptOwnershipRecoveryBudget,nativeQueryFailureObservations,updatedAtEpochMs:Date.now()});
   const observationDelay=postScriptOwnershipRecoveryWaiting||cancelled||timedOut||settled===null?200:1000;
   await new Promise(resolve=>setTimeout(resolve,observationDelay));
  }
  if(cancelled)terminate();
  await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:cancelled?'cancelled':'exited',timedOut,...settled,kernelChildExitObservation,linuxKernelContainmentVerified,linuxKernelContainmentContinuityLost,nativeOwnershipUnproven,ownedProcesses:ownedProcessHistory(),updatedAtEpochMs:Date.now()});
 } else await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:'cancelled',timedOut,error:containmentPreparationError??undefined,ownedProcesses:[],updatedAtEpochMs:Date.now()});
 await launchPostProcessExitCleanup();
 dispatchAgain=await waitForSemanticBusinessRecovery();
 }
 if(!initialBusinessDispatchPermitted&&!cancelled&&!await revoked())await save('supervisor-progress-'+nonce+'.json',{launchNonce:nonce,status:'exited',timedOut,ownedProcesses:[],updatedAtEpochMs:Date.now()});
 if(cancelled||await revoked()) {
  let previousSupervisorProgress={};
  try{previousSupervisorProgress=JSON.parse(await readFile(join(directory,'supervisor-progress-'+nonce+'.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  await save('supervisor-progress-'+nonce+'.json',{ownedProcesses:[],...previousSupervisorProgress,launchNonce:nonce,status:'cancelled',timedOut,updatedAtEpochMs:Date.now()});
 }
}
`;

export interface IndependentOwnedCommandSupervisorOptions {
	artifactDirectory?: string;
	deadlineAtEpochMs?: number;
	environment?: Record<string, string>;
	outputTailMaxChars?: number;
	preventRedispatch?: boolean;
	skipProducerCancelCommand?: boolean;
	superviseProcessGroup?: boolean;
	semanticRecoveryObservationIntervalMs?: number;
}

type OwnedCommandSupervisorReference = Pick<TaskCommandExecutionRecord, "workspaceId" | "executionId" | "launchNonce">;

export async function inspectOwnedCommandSupervisor(
	record: OwnedCommandSupervisorReference,
	options: IndependentOwnedCommandSupervisorOptions = {},
): Promise<"running" | "exited" | "not_started" | "unknown"> {
	const directory =
		options.artifactDirectory ?? taskCommandExecutionArtifactDirectory(record.workspaceId, record.executionId);
	try {
		const aborted = JSON.parse(
			await readFile(join(directory, `supervisor-launch-aborted-${record.launchNonce}.json`), "utf8"),
		) as { launchNonce?: string; phase?: string };
		if (aborted.launchNonce === record.launchNonce && aborted.phase === "supervisor_spawn_not_invoked")
			return "exited";
	} catch {
		/* 没有未派发原件时继续核验。 */
	}

	let hasPersistedSupervisorIdentity = false;
	try {
		const owner = JSON.parse(
			await readFile(join(directory, `supervisor-identity-${record.launchNonce}.json`), "utf8"),
		) as OwnedProcessIdentity;
		hasPersistedSupervisorIdentity = true;
		const launchMaterials = JSON.parse(
			await readFile(join(directory, `launch-materials-${record.launchNonce}.json`), "utf8"),
		) as { darwinOriginalParentGenerationProbePath?: string | null; superviseProcessGroup?: boolean };
		const requiresPreciseNativeIdentity =
			options.superviseProcessGroup === true || launchMaterials.superviseProcessGroup === true;
		const current = await readProcessIdentity(
			owner.pid,
			launchMaterials.darwinOriginalParentGenerationProbePath,
			owner.nativeProcessGenerationIdentity !== undefined,
		);
		if (
			requiresPreciseNativeIdentity &&
			current &&
			(!owner.nativeProcessGenerationIdentity || !current.nativeProcessGenerationIdentity)
		)
			return "unknown";
		if (hasSameProcessGeneration(current, owner)) return "running";
		const materials = JSON.parse(
			await readFile(join(directory, `launch-materials-${record.launchNonce}.json`), "utf8"),
		) as { systemBootIdentity: string | null };
		const currentBoot = await readSystemBootIdentity();
		if (currentBoot && materials.systemBootIdentity && currentBoot !== materials.systemBootIdentity) return "exited";
		const progress = JSON.parse(
			await readFile(join(directory, `supervisor-progress-${record.launchNonce}.json`), "utf8"),
		) as {
			launchNonce?: string;
			status: string;
			ownedProcesses: OwnedProcessIdentity[];
			businessDispatchQuiescent?: boolean;
		};
		for (const { expected: process, current } of await observeOwnedProcessGenerations(
			progress.ownedProcesses,
			launchMaterials.darwinOriginalParentGenerationProbePath,
		)) {
			if (current === "unreadable") return "unknown";
			if (
				requiresPreciseNativeIdentity &&
				current &&
				(!process.nativeProcessGenerationIdentity || !current.nativeProcessGenerationIdentity)
			)
				return "unknown";
			if (hasSameProcessGeneration(current, process)) return "running";
		}
		if (
			progress.launchNonce === record.launchNonce &&
			progress.status === "machine_evidence_pending" &&
			progress.businessDispatchQuiescent === true &&
			progress.ownedProcesses.length === 0
		) {
			// 从静止等待派发前先写 dispatch_committed，所以只有等待原件仍在且监督者确证退出时才能接续。
			if (current) return "exited";
			try {
				process.kill(owner.pid, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return "exited";
			}
		}
		// 过期快照可能遗漏失联前刚派生的孤儿；只有终结原件或开机代际变化才能证明全部退出。
		return progress.status === "exited" || progress.status === "cancelled" ? "exited" : "unknown";
	} catch (error) {
		if (hasPersistedSupervisorIdentity || (error as NodeJS.ErrnoException).code !== "ENOENT") return "unknown";
		try {
			const { stdout } = await executeFile("ps", ["-axo", "command="], {
				timeout: 5_000,
				maxBuffer: 32 * 1024 * 1024,
			});
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
	record: OwnedCommandSupervisorReference &
		Pick<TaskCommandExecutionRecord, "revocationFile" | "launchAttemptCount"> & {
			specification: Pick<
				TaskCommandExecutionRecord["specification"],
				"workingDirectory" | "command" | "resumeCommand"
			> &
				Partial<TaskCommandExecutionRecord["specification"]>;
		},
	validate: () => Promise<void>,
	options: IndependentOwnedCommandSupervisorOptions = {},
): Promise<void> {
	const directory =
		options.artifactDirectory ?? taskCommandExecutionArtifactDirectory(record.workspaceId, record.executionId);
	await mkdir(directory, { recursive: true });
	await lockedFileSystem.withLock({ path: join(directory, "supervisor-launch"), type: "file" }, async () => {
		const inspection = await inspectOwnedCommandSupervisor(record, options);
		if (inspection === "running" || (options.preventRedispatch && inspection !== "not_started")) return;
		let supervisorSpawnMayHaveStarted = false;
		try {
			await validate();
			const entrypoint = join(directory, "owned-command-supervisor.mjs");
			const materialsFile = join(directory, `launch-materials-${record.launchNonce}.json`);
			const linuxContainment =
				options.superviseProcessGroup && process.platform === "linux"
					? await prepareLinuxKernelChildSubreaperContainmentAddon()
					: { addonPath: null, unavailabilityReason: null };

			await lockedFileSystem.writeTextFileAtomic(entrypoint, supervisorSource, { durable: true });
			await lockedFileSystem.writeJsonFileAtomic(
				materialsFile,
				{
					...options,
					directory,
					launchNonce: record.launchNonce,
					executionId: record.executionId,
					revocationFile: record.revocationFile,
					workingDirectory: record.specification.workingDirectory,
					materialSha256: record.specification.materialSha256,
					postProcessExitCleanupCommand: record.specification.postProcessExitCleanupCommand,
					command:
						record.launchAttemptCount > 1 ? record.specification.resumeCommand : record.specification.command,
					isRecoveryLaunch: record.launchAttemptCount > 1,
					producerExecutionRevocationFile: record.specification.producerExecutionRevocationFile,
					semanticRecovery: record.specification.supervisorMaintainsSemanticRecovery
						? {
								resultFile: record.specification.resultFile,
								materialSha256: record.specification.materialSha256,
								observationCommand: record.specification.readOnlyRecoveryEvidenceObservationCommand,
								validationCommand: record.specification.beforeSupervisorRecoveryDispatchValidationCommand,
								resumeCommand: record.specification.resumeCommand,
							}
						: null,
					systemBootIdentity: await readSystemBootIdentity(),
					linuxKernelChildSubreaperContainmentRequired:
						options.superviseProcessGroup === true && process.platform === "linux",
					linuxKernelChildSubreaperContainmentAddonPath: linuxContainment.addonPath,
					linuxKernelChildSubreaperContainmentUnavailabilityReason: linuxContainment.unavailabilityReason,
					commandNodeOptions: process.env.NODE_OPTIONS ?? null,

					darwinOriginalParentGenerationProbePath: options.superviseProcessGroup
						? await prepareDarwinProcessOriginalParentGenerationProbe()
						: null,
				},
				{ durable: true },
			);
			await validate();
			const log = await open(join(directory, `supervisor-${record.launchNonce}.log`), "a", 0o600);
			try {
				await lockedFileSystem.writeJsonFileAtomic(
					join(directory, `supervisor-spawn-dispatch-barrier-${record.launchNonce}.json`),
					{ launchNonce: record.launchNonce, phase: "supervisor_spawn_may_start" },
					{ durable: true },
				);
				supervisorSpawnMayHaveStarted = true;
				const supervisor = spawn(process.execPath, [entrypoint, materialsFile], {
					detached: true,
					env: options.superviseProcessGroup ? { ...process.env, NODE_OPTIONS: "" } : process.env,
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
		} catch (error) {
			if (options.preventRedispatch && !supervisorSpawnMayHaveStarted) {
				await lockedFileSystem.writeJsonFileAtomic(
					join(directory, `supervisor-launch-aborted-${record.launchNonce}.json`),
					{ launchNonce: record.launchNonce, phase: "supervisor_spawn_not_invoked", reason: String(error) },
					{ durable: true },
				);
			}
			throw error;
		}
	});
}

async function discoverNativeEnvironmentOwnedCommandProcesses(
	launchNonce: string,
	darwinNativeProbePath?: string | null,
): Promise<OwnedProcessIdentity[]> {
	const { stdout } = await executeFile("ps", ["-axo", "pid=,stat="], { timeout: 1000, maxBuffer: 32 * 1024 * 1024 });
	const pids = stdout
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter((fields) => fields[0] && !/^[ZX]/.test(fields[1] ?? ""))
		.map((fields) => Number(fields[0]))
		.filter((pid) => Number.isInteger(pid) && pid > 0);
	if (process.platform === "darwin" && darwinNativeProbePath) {
		const result = await executeFile(darwinNativeProbePath, [launchNonce, ...pids.map(String)], {
			timeout: 1000,
			maxBuffer: 32 * 1024 * 1024,
		});
		const rows = JSON.parse(result.stdout) as {
			pid: number;
			processIdVersion: number;
			processUniqueIdentity: string;
			hasExecutionOwnershipToken: boolean | null;
		}[];
		const identities: OwnedProcessIdentity[] = [];
		for (const row of rows)
			if (row.hasExecutionOwnershipToken === true) {
				const current = await readProcessIdentity(row.pid, darwinNativeProbePath, true);
				if (current?.nativeProcessGenerationIdentity === `darwin_unique_process_id:${row.processUniqueIdentity}`)
					identities.push(current);
			}
		return identities;
	}
	if (process.platform !== "linux") return [];
	const observations = await Promise.all(
		pids.map((pid) =>
			limitProcessIdentityQueries(async () => {
				try {
					const beforeStat = await readFile(`/proc/${pid}/stat`, "utf8");
					const environment = await readFile(`/proc/${pid}/environ`, "utf8");
					if (
						!environment
							.split(String.fromCharCode(0))
							.includes(`KANBAN_OWNED_COMMAND_EXECUTION_NONCE=${launchNonce}`)
					)
						return null;
					const afterStat = await readFile(`/proc/${pid}/stat`, "utf8");
					const ticks = (value: string) => value.slice(value.lastIndexOf(")") + 2).split(/\s+/)[19];
					if (!ticks(beforeStat) || ticks(beforeStat) !== ticks(afterStat)) return null;
					return {
						pid,
						startAndCommand: "native process observation",
						nativeProcessGenerationIdentity: `linux:${ticks(afterStat)}`,
					};
				} catch {
					return null;
				}
			}),
		),
	);
	return observations.filter((identity) => identity !== null);
}

export async function cancelOwnedCommandProcesses(
	record: Pick<
		TaskCommandExecutionRecord,
		"workspaceId" | "executionId" | "launchNonce" | "previousLaunchNonces" | "revocationFile"
	> & {
		specification: Pick<TaskCommandExecutionRecord["specification"], "cancelCommand" | "workingDirectory">;
	},
	options: IndependentOwnedCommandSupervisorOptions = {},
): Promise<Record<string, unknown>> {
	const directory =
		options.artifactDirectory ?? taskCommandExecutionArtifactDirectory(record.workspaceId, record.executionId);
	const observations: Record<string, unknown>[] = [];
	let darwinNativeProbePath: string | null | undefined;
	let usesPersistentOwnedProcessSupervision = options.superviseProcessGroup === true;
	try {
		const materials = JSON.parse(
			await readFile(join(directory, `launch-materials-${record.launchNonce}.json`), "utf8"),
		) as { darwinOriginalParentGenerationProbePath?: string | null; superviseProcessGroup?: boolean };
		darwinNativeProbePath = materials.darwinOriginalParentGenerationProbePath;
		usesPersistentOwnedProcessSupervision ||= materials.superviseProcessGroup === true;
	} catch {
		/* 缺失原件保持未知。 */
	}

	const cancelCommand = record.specification.cancelCommand;
	if (cancelCommand?.[0] && !options.skipProducerCancelCommand) {
		const dispatchBarrierPath = join(directory, "producer-cancel-command-dispatch-committed.json");
		const dispatchReserved = await lockedFileSystem.withLock(
			{ path: dispatchBarrierPath, type: "file" },
			async () => {
				try {
					await readFile(dispatchBarrierPath);
					return false;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				await lockedFileSystem.writeJsonFileAtomic(
					dispatchBarrierPath,
					{
						executionId: record.executionId,
						launchNonce: record.launchNonce,
						phase: "producer_cancel_command_may_start",
					},
					{ lock: null, durable: true },
				);
				return true;
			},
		);
		if (dispatchReserved) {
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
		if (usesPersistentOwnedProcessSupervision) {
			try {
				ownedProcesses.push(
					...(await discoverNativeEnvironmentOwnedCommandProcesses(record.launchNonce, darwinNativeProbePath)),
				);
			} catch {
				observations.push({
					status: "unknown",
					recoveryTrigger: "native_environment_ownership_evidence_available",
				});
			}
		}

		if (usesPersistentOwnedProcessSupervision && ownedProcesses.length > 0) {
			const supplementalPath = join(directory, `supplemental-owned-process-identities-${record.launchNonce}.json`);
			let prior: OwnedProcessIdentity[] = [];
			try {
				prior = (JSON.parse(await readFile(supplementalPath, "utf8")) as { ownedProcesses: OwnedProcessIdentity[] })
					.ownedProcesses;
			} catch {
				/* 首次补证。 */
			}
			const merged = new Map(
				[...prior, ...ownedProcesses].map((identity) => [
					JSON.stringify([identity.pid, identity.nativeProcessGenerationIdentity ?? identity.startAndCommand]),
					identity,
				]),
			);
			await lockedFileSystem.writeJsonFileAtomic(
				supplementalPath,
				{ launchNonce: record.launchNonce, ownedProcesses: [...merged.values()] },
				{ durable: true },
			);
		}
		const terminationRequestedOwners: OwnedProcessIdentity[] = [];
		const candidates = await observeOwnedProcessGenerations(ownedProcesses, darwinNativeProbePath);
		for (const { expected: owner, current: observed } of candidates.reverse()) {
			if (observed === "unreadable") {
				observations.push({ pid: owner.pid, status: "unknown" });
				continue;
			}
			if (!observed || !hasSameProcessGeneration(observed, owner)) {
				observations.push({
					pid: owner.pid,
					status: observed
						? usesPersistentOwnedProcessSupervision && !observed.nativeProcessGenerationIdentity
							? "precise_native_process_generation_unavailable_no_signal"
							: "identity_changed_no_signal"
						: "exited",
				});
				continue;
			}
			try {
				const current = await readProcessIdentity(
					owner.pid,
					darwinNativeProbePath,
					owner.nativeProcessGenerationIdentity !== undefined,
				);
				if (
					(!usesPersistentOwnedProcessSupervision ||
						(owner.nativeProcessGenerationIdentity && current?.nativeProcessGenerationIdentity)) &&
					hasSameProcessGeneration(current, owner)
				) {
					process.kill(owner.pid, "SIGTERM");
					terminationRequestedOwners.push(owner);
				}
				observations.push({
					pid: owner.pid,
					status:
						usesPersistentOwnedProcessSupervision &&
						current &&
						(!owner.nativeProcessGenerationIdentity || !current.nativeProcessGenerationIdentity)
							? "precise_native_process_generation_unavailable_no_signal"
							: current
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
					const current = await readProcessIdentity(
						owner.pid,
						darwinNativeProbePath,
						owner.nativeProcessGenerationIdentity !== undefined,
					);
					if (
						(!usesPersistentOwnedProcessSupervision ||
							(owner.nativeProcessGenerationIdentity && current?.nativeProcessGenerationIdentity)) &&
						hasSameProcessGeneration(current, owner)
					)
						process.kill(owner.pid, "SIGKILL");
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

export async function readOwnedCommandCancellationEvidenceFingerprint(
	record: Pick<TaskCommandExecutionRecord, "workspaceId" | "executionId" | "launchNonce" | "previousLaunchNonces">,
): Promise<string> {
	const directory = taskCommandExecutionArtifactDirectory(record.workspaceId, record.executionId);
	const identities: OwnedProcessIdentity[] = [];
	const files: unknown[] = [];
	let nativeProbePath: string | null | undefined;
	for (const nonce of [...record.previousLaunchNonces, record.launchNonce]) {
		for (const prefix of [
			"launch-materials",
			"supervisor-identity",
			"supervisor-progress",
			"supplemental-owned-process-identities",
		]) {
			try {
				const path = join(directory, `${prefix}-${nonce}.json`);
				const material = JSON.parse(await readFile(path, "utf8")) as {
					pid?: number;
					startAndCommand?: string;
					nativeProcessGenerationIdentity?: string;
					ownedProcesses?: OwnedProcessIdentity[];
					darwinOriginalParentGenerationProbePath?: string | null;
					superviseProcessGroup?: boolean;
				};
				// 相同归属原件的原子重写与心跳不产生新的取消证据，不能重置主动补查预算。
				files.push([
					nonce,
					prefix,
					material.superviseProcessGroup === true,
					material.darwinOriginalParentGenerationProbePath ?? null,
				]);
				identities.push(...(material.ownedProcesses ?? []));
				if (material.pid && material.startAndCommand)
					identities.push({
						pid: material.pid,
						startAndCommand: material.startAndCommand,
						nativeProcessGenerationIdentity: material.nativeProcessGenerationIdentity,
					});
				nativeProbePath ??= material.darwinOriginalParentGenerationProbePath;
			} catch (error) {
				files.push([nonce, prefix, (error as NodeJS.ErrnoException).code ?? "unreadable"]);
			}
		}
	}
	const observations = await observeOwnedProcessGenerations(identities, nativeProbePath);
	return createHash("sha256")
		.update(JSON.stringify({ files, boot: await readSystemBootIdentity(), observations }))
		.digest("hex");
}
