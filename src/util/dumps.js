// Keep the newest `limit` files named `${prefix}<timestamp>.json` in `dir` (best effort).
export async function pruneDumps(fs, path, dir, prefix, limit) {
  const names = await fs.readdir(dir);
  const dumps = names.filter((n) => n.startsWith(prefix) && n.endsWith('.json')).sort();
  for (const name of dumps.slice(0, Math.max(0, dumps.length - limit))) {
    await fs.rm(path.resolve(dir, name), { force: true }).catch(() => {});
  }
}
