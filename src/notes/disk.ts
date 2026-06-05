import { statSync, statfsSync } from "node:fs";

const GiB = 1024 ** 3;

// Free space on the LOCAL startup volume (where the Google Drive stream cache
// lives), NOT on the Drive FUSE mount. Always probe a local path (cwd), never
// the Drive path — statfs on the mount reports Drive's quota, not local disk.
export function freeGbLocal(): number {
  const s = statfsSync(process.cwd());
  return (Number(s.bavail) * Number(s.bsize)) / GiB;
}

export function fileSizeGb(path: string): number {
  return statSync(path).size / GiB;
}
