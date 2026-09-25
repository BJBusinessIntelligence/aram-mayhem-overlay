// Lockfile format: LeagueClient:PID:PORT:PASSWORD:PROTOCOL
export function parseLockfile(text) {
  const parts = String(text ?? '').trim().split(':');
  if (parts.length < 5) throw new Error('malformed lockfile');
  const [name, pid, port, password, protocol] = parts;
  const portN = Number(port);
  if (!Number.isInteger(portN) || portN <= 0 || !password) throw new Error('malformed lockfile');
  return { name, pid: Number(pid), port: portN, password, protocol };
}

// null = client not running (or file transiently unreadable). Never throws.
export async function readLockfile(filePath, { fs }) {
  let text;
  try { text = await fs.readFile(filePath, 'utf8'); } catch { return null; }
  if (!String(text).trim()) return null;
  try { return parseLockfile(text); } catch { return null; }
}
