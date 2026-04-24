const MAX_ENTRIES = 2000;
const TTL_MS = 60 * 60 * 1000;

const seen = new Map<string, number>();

function key(agentId: string, updateId: number): string {
  return `${agentId}:${updateId}`;
}

function prune(): void {
  if (seen.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, ts] of seen) {
    if (now - ts > TTL_MS) seen.delete(k);
  }
  while (seen.size > MAX_ENTRIES) {
    const first = seen.keys().next().value;
    if (first === undefined) break;
    seen.delete(first);
  }
}

export function hasSeenUpdate(agentId: string, updateId: number): boolean {
  const ts = seen.get(key(agentId, updateId));
  if (ts === undefined) return false;
  if (Date.now() - ts > TTL_MS) {
    seen.delete(key(agentId, updateId));
    return false;
  }
  return true;
}

export function markSeenUpdate(agentId: string, updateId: number): void {
  seen.set(key(agentId, updateId), Date.now());
  prune();
}
