/**
 * Agent telemetry — manual OTEL spans + SQLite event logging.
 * Receives SDK messages from the query loop and creates traces.
 *
 * Public API:
 *   init(config)      — initialize OTEL pipeline and SQLite (call once at startup)
 *   onQueryStart()    — start root AGENT span
 *   onMessage(msg)    — process each SDK message (creates/ends child spans)
 *   onQueryEnd()      — end orphaned spans, flush
 *   shutdown()        — flush and close everything
 */
import type { Span, Tracer } from '@opentelemetry/api';

// Lazy-loaded modules (heavy deps, only load if Langfuse is configured)
let tracer: Tracer | null = null;
let spanProcessor: { forceFlush: () => Promise<void> } | null = null;
let otelSdk: { shutdown: () => Promise<void> } | null = null;
let db: import('better-sqlite3').Database | null = null;

// Active span state
let rootSpan: Span | null = null;
const pendingTools = new Map<string, Span>(); // tool_use_id → TOOL span
const pendingSubagents = new Map<string, Span>(); // task_id → AGENT span

// Accumulated data for root span
let queryModel: string | null = null;
let querySessionId: string | null = null;
let lastAssistantText: string | null = null;

export interface TelemetryConfig {
  secrets: Record<string, string>;
  groupFolder: string;
  chatJid: string;
  assistantName?: string;
  dbPath: string;
}

function log(msg: string): void {
  console.error(`[telemetry] ${msg}`);
}

/**
 * Initialize OTEL pipeline and SQLite. Call once at startup.
 */
export async function init(config: TelemetryConfig): Promise<void> {
  // SQLite setup
  try {
    const Database = (await import('better-sqlite3')).default;
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        tool_name TEXT,
        data TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cost_usd REAL,
        duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_agent_events_session ON agent_events(session_id);
    `);
    log('SQLite event store initialized');
  } catch (err) {
    log(`SQLite init failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  // OTEL/Langfuse setup
  if (!config.secrets.LANGFUSE_SECRET_KEY) {
    log('Langfuse skipped: LANGFUSE_SECRET_KEY not in secrets');
    return;
  }

  try {
    process.env.LANGFUSE_PUBLIC_KEY = config.secrets.LANGFUSE_PUBLIC_KEY || '';
    process.env.LANGFUSE_SECRET_KEY = config.secrets.LANGFUSE_SECRET_KEY;
    process.env.LANGFUSE_BASE_URL =
      config.secrets.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com';
    process.env.OTEL_SERVICE_NAME = 'nanoclaw-agent';
    process.env.OTEL_RESOURCE_ATTRIBUTES = [
      `nanoclaw.agent.name=${config.assistantName || 'unknown'}`,
      `nanoclaw.group=${config.groupFolder}`,
      `nanoclaw.chat_jid=${config.chatJid}`,
    ].join(',');

    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { LangfuseSpanProcessor } = await import('@langfuse/otel');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = new (LangfuseSpanProcessor as any)({
      flushAt: 1,
      flushInterval: 1000,
    });
    spanProcessor = proc;

    const sdk = new NodeSDK({ spanProcessors: [proc] });
    sdk.start();
    otelSdk = sdk;

    const { trace } = await import('@opentelemetry/api');
    tracer = trace.getTracer('nanoclaw-agent', '1.0.0');

    log('Langfuse telemetry initialized');
  } catch (err) {
    log(`Langfuse init failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Called when a new query turn starts.
 */
export function onQueryStart(prompt: string, sessionId?: string): void {
  querySessionId = sessionId || null;
  queryModel = null;
  lastAssistantText = null;

  if (tracer) {
    rootSpan = tracer.startSpan('ClaudeAgent.query', {
      attributes: {
        'openinference.span.kind': 'AGENT',
        'input.value': prompt,
        'input.mime_type': 'text/plain',
        ...(sessionId ? { 'session.id': sessionId } : {}),
      },
    });
  }

  storeEvent('query_start', { prompt }, sessionId);
}

/**
 * Called for every SDK message yielded by the query generator.
 */
export function onMessage(message: Record<string, unknown>): void {
  const type = message.type as string;
  const subtype = message.subtype as string | undefined;

  if (type === 'system' && subtype === 'init') {
    handleSystemInit(message);
  } else if (type === 'assistant' && message.message) {
    handleAssistant(message);
  } else if (type === 'user' && message.tool_use_result !== undefined) {
    handleToolResult(message);
  } else if (type === 'system' && subtype === 'task_started') {
    handleSubagentStart(message);
  } else if (type === 'system' && subtype === 'task_progress') {
    handleSubagentProgress(message);
  } else if (type === 'system' && subtype === 'task_notification') {
    handleSubagentEnd(message);
  } else if (type === 'result') {
    handleResult(message);
  }
}

/**
 * Called after the for-await loop ends.
 */
export async function onQueryEnd(): Promise<void> {
  // End any orphaned spans
  if (rootSpan) {
    rootSpan.end();
    rootSpan = null;
  }
  for (const [id, span] of pendingTools) {
    span.end();
    pendingTools.delete(id);
  }
  for (const [id, span] of pendingSubagents) {
    span.end();
    pendingSubagents.delete(id);
  }

  lastAssistantText = null;

  // Wait for span processor to handle onEnd, then flush
  await new Promise((r) => setTimeout(r, 100));
  await flush();
}

/**
 * Shutdown — flush and close everything.
 */
export async function shutdown(): Promise<void> {
  await onQueryEnd();
  if (otelSdk) {
    try {
      await otelSdk.shutdown();
    } catch {}
  }
  if (db) {
    try {
      db.close();
    } catch {}
  }
}

// ─── Message Handlers ─────────────────────────────────────────

function handleSystemInit(message: Record<string, unknown>): void {
  const sid = message.session_id as string;
  const model = message.model as string;
  querySessionId = sid;
  queryModel = model;
  rootSpan?.setAttribute('session.id', sid);
  rootSpan?.setAttribute('llm.model_name', model);
}

function handleAssistant(message: Record<string, unknown>): void {
  const msg = message.message as Record<string, unknown>;
  const content = msg.content as Array<Record<string, unknown>> | undefined;
  const model = msg.model as string | undefined;

  if (model && !queryModel) {
    queryModel = model;
    rootSpan?.setAttribute('llm.model_name', model);
  }

  if (!content) return;

  for (const block of content) {
    if (block.type === 'text' && block.text) {
      lastAssistantText = block.text as string;
    }

    if (block.type === 'tool_use') {
      const toolName = block.name as string;
      const toolInput = block.input as Record<string, unknown>;
      const toolUseId = block.id as string;

      if (tracer) {
        const toolSpan = tracer.startSpan(toolName, {
          attributes: {
            'openinference.span.kind': 'TOOL',
            'tool.name': toolName,
            'tool.parameters': JSON.stringify(toolInput),
            'input.value': JSON.stringify(toolInput),
            'input.mime_type': 'application/json',
          },
        });
        pendingTools.set(toolUseId, toolSpan);
      }

      storeEvent(
        'tool_call',
        { tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId },
        querySessionId,
        toolName,
      );
    }
  }
}

function handleToolResult(message: Record<string, unknown>): void {
  const parentId = message.parent_tool_use_id as string | null;
  if (!parentId) return;

  const toolSpan = pendingTools.get(parentId);
  if (toolSpan) {
    const resultStr =
      typeof message.tool_use_result === 'string'
        ? message.tool_use_result
        : JSON.stringify(message.tool_use_result);
    toolSpan.setAttribute('output.value', resultStr.slice(0, 10000));
    toolSpan.setAttribute('output.mime_type', 'application/json');
    toolSpan.end();
    pendingTools.delete(parentId);
    flush();
  }

  storeEvent(
    'tool_result',
    { parent_tool_use_id: parentId, result: message.tool_use_result },
    querySessionId,
  );
}

function handleSubagentStart(message: Record<string, unknown>): void {
  const taskId = message.task_id as string;
  const description = message.description as string;

  if (tracer) {
    const subSpan = tracer.startSpan(`Subagent: ${description}`, {
      attributes: {
        'openinference.span.kind': 'AGENT',
        'input.value': description,
        'task.id': taskId,
      },
    });
    pendingSubagents.set(taskId, subSpan);
  }

  storeEvent(
    'subagent_start',
    { task_id: taskId, description, task_type: message.task_type },
    querySessionId,
  );
}

function handleSubagentProgress(message: Record<string, unknown>): void {
  const taskId = message.task_id as string;
  const subSpan = pendingSubagents.get(taskId);
  const usage = message.usage as
    | { total_tokens?: number; tool_uses?: number; duration_ms?: number }
    | undefined;
  if (subSpan && usage) {
    subSpan.setAttribute('llm.token_count.total', usage.total_tokens || 0);
  }
}

function handleSubagentEnd(message: Record<string, unknown>): void {
  const taskId = message.task_id as string;
  const status = message.status as string;
  const summary = message.summary as string;
  const usage = message.usage as
    | { total_tokens?: number; tool_uses?: number; duration_ms?: number }
    | undefined;

  const subSpan = pendingSubagents.get(taskId);
  if (subSpan) {
    subSpan.setAttribute('output.value', summary || '');
    subSpan.setAttribute('output.mime_type', 'text/plain');
    if (usage) {
      subSpan.setAttribute('llm.token_count.total', usage.total_tokens || 0);
    }
    if (status === 'failed' || status === 'stopped') {
      subSpan.setStatus({ code: 2, message: status }); // SpanStatusCode.ERROR = 2
    }
    subSpan.end();
    pendingSubagents.delete(taskId);
    flush();
  }

  storeEvent(
    'subagent_end',
    { task_id: taskId, status, summary, usage },
    querySessionId,
  );
}

function handleResult(message: Record<string, unknown>): void {
  const resultText = message.result as string | null;
  const finalText = resultText || lastAssistantText || null;
  const totalCost = message.total_cost_usd as number | undefined;
  const usage = message.usage as
    | { input_tokens?: number; output_tokens?: number }
    | undefined;
  const durationMs = message.duration_ms as number | undefined;

  if (rootSpan) {
    if (finalText) {
      rootSpan.setAttribute('output.value', finalText);
      rootSpan.setAttribute('output.mime_type', 'text/plain');
    }
    if (usage) {
      rootSpan.setAttribute('llm.token_count.prompt', usage.input_tokens || 0);
      rootSpan.setAttribute(
        'llm.token_count.completion',
        usage.output_tokens || 0,
      );
      rootSpan.setAttribute(
        'llm.token_count.total',
        (usage.input_tokens || 0) + (usage.output_tokens || 0),
      );
    }
    if (totalCost !== undefined) {
      rootSpan.setAttribute('llm.cost.total', totalCost);
    }
    if (queryModel) {
      rootSpan.setAttribute('llm.model_name', queryModel);
    }
    rootSpan.end();
    rootSpan = null;
  }

  storeEvent(
    'result',
    {
      subtype: message.subtype,
      result: finalText,
      total_cost_usd: totalCost,
      usage,
      model_usage: message.modelUsage,
      duration_ms: durationMs,
    },
    querySessionId,
    undefined,
    usage?.input_tokens,
    usage?.output_tokens,
    totalCost,
    durationMs,
  );
}

// ─── Internal Helpers ─────────────────────────────────────────

async function flush(): Promise<void> {
  if (!spanProcessor) return;
  try {
    await spanProcessor.forceFlush();
  } catch {
    /* non-fatal */
  }
}

function storeEvent(
  eventType: string,
  data: Record<string, unknown>,
  sessionId?: string | null,
  toolName?: string,
  inputTokens?: number,
  outputTokens?: number,
  costUsd?: number,
  durationMs?: number,
): void {
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO agent_events (session_id, event_type, tool_name, data, input_tokens, output_tokens, cost_usd, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId || '',
      eventType,
      toolName || null,
      JSON.stringify(data),
      inputTokens || null,
      outputTokens || null,
      costUsd || null,
      durationMs || null,
    );
  } catch (err) {
    log(
      `SQLite write error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
