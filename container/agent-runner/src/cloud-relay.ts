import { createHmac } from 'crypto';
import type { AgentEvent } from './types.js';

let buffer: AgentEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let db: import('better-sqlite3').Database | null = null;
let cloudUrl: string | null = null;
let eventSecret: string | null = null;
let tenantId: string | null = null;
let retryDelayMs = 500;
const MAX_BUFFER = 1000;
const FLUSH_INTERVAL_MS = 500;
const FLUSH_BATCH_SIZE = 10;
const MAX_RETRY_DELAY_MS = 30000;

function log(msg: string): void {
  console.error(`[cloud-relay] ${msg}`);
}

export interface CloudRelayConfig {
  db: import('better-sqlite3').Database;
  cloudUrl: string;
  eventSecret: string;
  tenantId: string;
}

export function init(config: CloudRelayConfig): void {
  db = config.db;
  cloudUrl = config.cloudUrl;
  eventSecret = config.eventSecret;
  tenantId = config.tenantId;

  // Ensure cloud sync columns exist (safe to re-run)
  try { db.exec(`ALTER TABLE agent_events ADD COLUMN cloud_id TEXT;`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE agent_events ADD COLUMN trace_id TEXT;`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE agent_events ADD COLUMN parent_event_id TEXT;`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE agent_events ADD COLUMN seq INTEGER;`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE agent_events ADD COLUMN synced INTEGER DEFAULT 0;`); } catch { /* already exists */ }

  // Flush unsynced events from previous sessions
  flushUnsyncedFromDb();

  // Start flush loop
  flushTimer = setInterval(() => {
    if (buffer.length > 0) flushBuffer();
  }, FLUSH_INTERVAL_MS);

  log(`initialized (url=${cloudUrl}, tenant=${tenantId})`);
}

/**
 * Store cloud fields for a SQLite row and buffer the event for push.
 * Pass sqliteRowId (from storeEvent's lastInsertRowid) for precise correlation.
 */
export function push(event: AgentEvent, sqliteRowId?: number): void {
  if (!cloudUrl || !eventSecret) return;

  // Update SQLite row with cloud fields (using exact row ID if available)
  if (db && sqliteRowId) {
    try {
      db.prepare(
        `UPDATE agent_events SET cloud_id = ?, trace_id = ?, parent_event_id = ?, seq = ?, synced = 0
         WHERE id = ?`
      ).run(event.id, event.trace_id, event.parent_event_id, event.seq, sqliteRowId);
    } catch (err) {
      log(`SQLite cloud fields update error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Add to buffer (drop oldest if over max — safe because SQLite has them)
  buffer.push(event);
  if (buffer.length > MAX_BUFFER) {
    buffer.shift();
  }

  // Flush if batch size reached
  if (buffer.length >= FLUSH_BATCH_SIZE) {
    flushBuffer();
  }
}

async function flushBuffer(): Promise<void> {
  if (buffer.length === 0 || !cloudUrl || !eventSecret || !tenantId) return;

  const batch = buffer.splice(0, 50); // max 50 per request
  const body = JSON.stringify({ events: batch });
  const signature = createHmac('sha256', eventSecret).update(body).digest('hex');

  try {
    const resp = await fetch(`${cloudUrl}/api/events/${tenantId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Event-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(10000),
    });

    if (resp.ok) {
      retryDelayMs = 500; // reset on success
      // Mark synced in SQLite
      if (db) {
        const ids = batch.map((e) => e.id);
        const placeholders = ids.map(() => '?').join(',');
        try {
          db.prepare(
            `UPDATE agent_events SET synced = 1 WHERE cloud_id IN (${placeholders})`
          ).run(...ids);
        } catch {}
      }
    } else if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get('retry-after') || '1', 10);
      buffer.unshift(...batch); // put back
      retryDelayMs = Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS);
      log(`rate limited, retry after ${retryAfter}s`);
    } else {
      buffer.unshift(...batch); // put back for retry
      retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
      log(`push failed (${resp.status}), retry in ${retryDelayMs}ms`);
    }
  } catch (err) {
    buffer.unshift(...batch); // put back for retry
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
    log(`push error: ${err instanceof Error ? err.message : String(err)}, retry in ${retryDelayMs}ms`);
  }
}

function flushUnsyncedFromDb(): void {
  if (!db || !cloudUrl || !eventSecret || !tenantId) return;

  try {
    const rows = db.prepare(
      `SELECT cloud_id, trace_id, event_type, data, session_id, tool_name,
              input_tokens, output_tokens, cost_usd, duration_ms, timestamp,
              parent_event_id, seq
       FROM agent_events WHERE synced = 0 AND cloud_id IS NOT NULL
       ORDER BY id ASC LIMIT 100`
    ).all() as Array<Record<string, unknown>>;

    if (rows.length === 0) return;
    log(`flushing ${rows.length} unsynced events from previous session`);

    for (const row of rows) {
      buffer.push({
        id: row.cloud_id as string,
        tenant_id: tenantId,
        trace_id: row.trace_id as string,
        parent_event_id: (row.parent_event_id as string) || null,
        seq: (row.seq as number) || 0,
        event_type: row.event_type as AgentEvent['event_type'],
        status: (row.event_type === 'result' || row.event_type === 'tool_result' || row.event_type === 'subagent_end')
          ? 'complete' : 'pending',
        agent_name: process.env.ASSISTANT_NAME || 'unknown',
        channel: 'unknown',
        data: JSON.parse((row.data as string) || '{}'),
        tokens_used: (row.input_tokens as number) || null,
        cost_usd: (row.cost_usd as number) || null,
        duration_ms: (row.duration_ms as number) || null,
        client_ts: row.timestamp as string,
      });
    }
  } catch (err) {
    log(`unsync flush error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function shutdown(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  // Final flush
  while (buffer.length > 0) {
    await flushBuffer();
  }
}
