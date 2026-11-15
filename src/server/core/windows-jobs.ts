import { Job } from "@seydx/win-job";

// The owner job is assigned before spawning: even a fast child cannot escape
// cleanup when the core exits or crashes. Per-run jobs also support Stop.
let owner: Job | undefined;
const children = new Map<number, Job>();

export function prepareWindowsChildren(): void {
  if (process.platform !== "win32" || owner) return;
  const job = new Job();
  try {
    job.assign(process.pid);
    owner = job;
  } catch (e) {
    job.close();
    throw e;
  }
}

export function watchWindowsChild(pid: number): () => void {
  if (process.platform !== "win32") return () => {};
  const job = new Job();
  try {
    job.assign(pid);
    children.set(pid, job);
  } catch (e) {
    job.close();
    throw e;
  }
  return () => {
    if (children.get(pid) !== job) return;
    children.delete(pid);
    job.close();
  };
}

export function killWindowsChild(pid: number): boolean {
  const job = children.get(pid);
  if (!job) return false;
  job.terminate();
  return true;
}
