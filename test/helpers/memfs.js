// In-memory stand-in for node:fs/promises. Keys are forward-slash paths.
export function createMemFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const norm = (p) => String(p).replace(/\\/g, '/');
  return {
    files,
    async readFile(p) {
      const k = norm(p);
      if (!files.has(k)) { const e = new Error(`ENOENT: no such file ${k}`); e.code = 'ENOENT'; throw e; }
      return files.get(k);
    },
    async writeFile(p, data) { files.set(norm(p), String(data)); },
    async mkdir() {},
    async rm(p) { files.delete(norm(p)); },
  };
}
