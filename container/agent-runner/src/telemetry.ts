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
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import type { AgentEvent, EventData } from './types.js';
import * as cloudRelay from './cloud-relay.js';

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

// Cloud relay state
let resolvedTenantId: string = ''; // set during init() from secrets or env
let resolvedAgentName: string = 'unknown'; // cached before sanitize hook wipes ASSISTANT_NAME
let currentTraceId: string | null = null;
let currentTaskId: string | null = null; // set from TASK_ID env at init()
let currentRootEventId: string | null = null;
let seqCounter = 0;
let agentChannel: string = 'unknown';
let currentPrompt: string = ''; // stored for query_start completion update

// Maps for correct parent tracking in the trace tree
const toolUseIdToCloudId = new Map<string, string>(); // tool_use_id → cloud event UUID
const taskIdToCloudId = new Map<string, string>(); // task_id → cloud event UUID

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
        duration_ms INTEGER,
        task_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_events_session ON agent_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_agent_events_task ON agent_events(task_id);
    `);
    log('SQLite event store initialized');
  } catch (err) {
    log(`SQLite init failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  // Cloud relay setup (if cloud URL is configured)
  const cloudUrl = config.secrets.PEPPER_CLOUD_URL || process.env.PEPPER_CLOUD_URL;
  const eventSecret = config.secrets.PEPPER_EVENT_SECRET || process.env.PEPPER_EVENT_SECRET;
  const tenantId = config.secrets.TENANT_ID || process.env.TENANT_ID;
  resolvedTenantId = tenantId || '';
  currentTaskId = config.secrets.TASK_ID || process.env.TASK_ID || null;
  resolvedAgentName = config.secrets.ASSISTANT_NAME || resolvedAgentName;
  if (cloudUrl && eventSecret && tenantId && db) {
    cloudRelay.init({ db, cloudUrl, eventSecret, tenantId });
    log('Cloud relay initialized');
  } else {
    log('Cloud relay skipped: missing PEPPER_CLOUD_URL, PEPPER_EVENT_SECRET, or TENANT_ID');
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
    process.env.OTEL_SERVICE_NAME = 'pepper-agent';
    process.env.OTEL_RESOURCE_ATTRIBUTES = [
      `pepper.agent.name=${config.assistantName || 'unknown'}`,
      `pepper.group=${config.groupFolder}`,
      `pepper.chat_jid=${config.chatJid}`,
    ].join(',');

    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { LangfuseSpanProcessor } = await import('@langfuse/otel');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = new (LangfuseSpanProcessor as any)({
      flushAt: 1,
      flushInterval: 1000,
      shouldExportSpan: () => true, // Export ALL spans (we only create the ones we want)
    });
    spanProcessor = proc;

    const sdk = new NodeSDK({ spanProcessors: [proc] });
    sdk.start();
    otelSdk = sdk;

    const { trace } = await import('@opentelemetry/api');
    tracer = trace.getTracer('pepper-agent', '1.0.0');

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

  currentTraceId = randomUUID();
  currentRootEventId = currentTraceId;
  seqCounter = 0;
  currentPrompt = prompt;
  toolUseIdToCloudId.clear();
  taskIdToCloudId.clear();

  const queryStartEvent: AgentEvent = {
    id: currentTraceId,
    agent_id: resolvedTenantId,
    trace_id: currentTraceId,
    parent_event_id: null,
    seq: seqCounter++,
    event_type: 'query_start',
    status: 'pending',
    agent_name: resolvedAgentName,
    channel: agentChannel,
    task_id: currentTaskId,
    data: { type: 'query_start', prompt, channel: agentChannel },
    tokens_used: null,
    cost_usd: null,
    duration_ms: null,
    client_ts: new Date().toISOString(),
  };
  cloudRelay.push(queryStartEvent);
}

/**
 * Emit a webchat_user_message event when a follow-up message is piped into an active query.
 * This allows the UI to render a "YOU" bubble for each user message within a single trace.
 */
export function emitUserMessage(text: string): void {
  if (!currentTraceId) return;

  const eventId = randomUUID();
  const event: AgentEvent = {
    id: eventId,
    agent_id: resolvedTenantId,
    trace_id: currentTraceId,
    parent_event_id: currentRootEventId,
    seq: seqCounter++,
    event_type: 'webchat_user_message',
    status: 'complete',
    agent_name: resolvedAgentName,
    channel: agentChannel,
    task_id: currentTaskId,
    data: { type: 'webchat_user_message', text },
    tokens_used: null,
    cost_usd: null,
    duration_ms: null,
    client_ts: new Date().toISOString(),
  };
  cloudRelay.push(event);
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
  await cloudRelay.shutdown();
  if (db) {
    try {
      db.close();
    } catch {}
  }
}

export function setChannel(channel: string): void {
  agentChannel = channel;
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
    if (block.type === 'thinking' && (block.thinking || block.text)) {
      const thinkingText = (block.thinking || block.text) as string;
      const reasoningEvent: AgentEvent = {
        id: randomUUID(),
        agent_id: resolvedTenantId,
        trace_id: currentTraceId || '',
        parent_event_id: currentRootEventId,
        seq: seqCounter++,
        event_type: 'reasoning',
        status: 'complete',
        agent_name: resolvedAgentName,
        channel: agentChannel,
        task_id: currentTaskId,
        data: { type: 'reasoning', text: thinkingText.slice(0, 260000) },
        tokens_used: null,
        cost_usd: null,
        duration_ms: null,
        client_ts: new Date().toISOString(),
      };
      cloudRelay.push(reasoningEvent);
    }

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

      const toolCloudId = randomUUID();
      toolUseIdToCloudId.set(toolUseId, toolCloudId);
      const toolCloudEvent: AgentEvent = {
        id: toolCloudId,
        agent_id: resolvedTenantId,
        trace_id: currentTraceId || '',
        parent_event_id: currentRootEventId,
        seq: seqCounter++,
        event_type: 'tool_call',
        status: 'pending',
        agent_name: resolvedAgentName,
        channel: agentChannel,
        task_id: currentTaskId,
        data: { type: 'tool_call', tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId },
        tokens_used: null,
        cost_usd: null,
        duration_ms: null,
        client_ts: new Date().toISOString(),
      };
      cloudRelay.push(toolCloudEvent);
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

  const resultStr = typeof message.tool_use_result === 'string'
    ? message.tool_use_result
    : JSON.stringify(message.tool_use_result);
  const toolCallCloudId = parentId ? toolUseIdToCloudId.get(parentId) : null;
  const toolResultEvent: AgentEvent = {
    id: randomUUID(),
    agent_id: resolvedTenantId,
    trace_id: currentTraceId || '',
    parent_event_id: toolCallCloudId || currentRootEventId,
    seq: seqCounter++,
    event_type: 'tool_result',
    status: 'complete',
    agent_name: resolvedAgentName,
    channel: agentChannel,
    task_id: currentTaskId,
    data: {
      type: 'tool_result',
      tool_use_id: parentId || '',
      output: resultStr.slice(0, 260000),
      is_error: false,
      ...(resultStr.length > 260000 ? { truncated: true } : {}),
    },
    tokens_used: null,
    cost_usd: null,
    duration_ms: null,
    client_ts: new Date().toISOString(),
  };
  cloudRelay.push(toolResultEvent);
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

  const subStartCloudId = randomUUID();
  taskIdToCloudId.set(taskId, subStartCloudId);
  const subStartEvent: AgentEvent = {
    id: subStartCloudId,
    agent_id: resolvedTenantId,
    trace_id: currentTraceId || '',
    parent_event_id: currentRootEventId,
    seq: seqCounter++,
    event_type: 'subagent_start',
    status: 'pending',
    agent_name: resolvedAgentName,
    channel: agentChannel,
    task_id: currentTaskId,
    data: { type: 'subagent_start', task_id: taskId, task_description: description },
    tokens_used: null,
    cost_usd: null,
    duration_ms: null,
    client_ts: new Date().toISOString(),
  };
  cloudRelay.push(subStartEvent);
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

  const subStartCloudIdForEnd = taskIdToCloudId.get(taskId);
  const subEndEvent: AgentEvent = {
    id: randomUUID(),
    agent_id: resolvedTenantId,
    trace_id: currentTraceId || '',
    parent_event_id: subStartCloudIdForEnd || currentRootEventId,
    seq: seqCounter++,
    event_type: 'subagent_end',
    status: status === 'completed' ? 'complete' : 'error',
    agent_name: resolvedAgentName,
    channel: agentChannel,
    task_id: currentTaskId,
    data: { type: 'subagent_end', task_id: taskId, status: status as 'completed' | 'failed' | 'stopped' },
    tokens_used: usage?.total_tokens || null,
    cost_usd: null,
    duration_ms: usage?.duration_ms || null,
    client_ts: new Date().toISOString(),
  };
  cloudRelay.push(subEndEvent);
}

function handleResult(message: Record<string, unknown>): void {
  const resultText = message.result as string | null;
  const finalText = resultText || lastAssistantText || null;
  const totalCost = message.total_cost_usd as number | undefined;
  const usage = message.usage as
    | { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
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

  const isError = (message.subtype as string)?.startsWith('error');
  const resultEvent: AgentEvent = {
    id: randomUUID(),
    agent_id: resolvedTenantId,
    trace_id: currentTraceId || '',
    parent_event_id: currentRootEventId,
    seq: seqCounter++,
    event_type: isError ? 'error' : 'response',
    status: isError ? 'error' : 'complete',
    agent_name: resolvedAgentName,
    channel: agentChannel,
    task_id: currentTaskId,
    data: isError
      ? { type: 'error', error_type: message.subtype as string, message: finalText || 'Unknown error' }
      : {
          type: 'response' as const,
          text: finalText || '',
          is_error: false,
          model_id: queryModel ?? undefined,
          input_tokens: usage?.input_tokens ?? 0,
          output_tokens: usage?.output_tokens ?? 0,
          cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
        },
    tokens_used: usage ? (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) : null,
    cost_usd: totalCost || null,
    duration_ms: durationMs || null,
    client_ts: new Date().toISOString(),
  };
  cloudRelay.push(resultEvent);

  // Update the query_start event status to complete (preserving original prompt)
  if (currentRootEventId) {
    const completeEvent: AgentEvent = {
      id: currentRootEventId,
      agent_id: resolvedTenantId,
      trace_id: currentTraceId || '',
      parent_event_id: null,
      seq: 0,
      event_type: 'query_start',
      status: isError ? 'error' : 'complete',
      agent_name: resolvedAgentName,
      channel: agentChannel,
      task_id: currentTaskId,
      data: { type: 'query_start', prompt: currentPrompt, channel: agentChannel },
      tokens_used: usage ? (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) : null,
      cost_usd: totalCost || null,
      duration_ms: durationMs || null,
      client_ts: new Date().toISOString(),
    };
    cloudRelay.push(completeEvent);
  }
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
      `INSERT INTO agent_events (session_id, event_type, tool_name, data, input_tokens, output_tokens, cost_usd, duration_ms, task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId || '',
      eventType,
      toolName || null,
      JSON.stringify(data),
      inputTokens || null,
      outputTokens || null,
      costUsd || null,
      durationMs || null,
      currentTaskId,
    );
  } catch (err) {
    log(
      `SQLite write error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Read any api_call entries from .data-costs.jsonl written during this query turn,
 * emit them as api_call cloud events, and truncate the file.
 * Called once after onQueryEnd() so all data API costs from a single query are batched.
 */
export function logPendingApiCalls(dataCostsPath: string): void {
  try {
    if (!fs.existsSync(dataCostsPath)) return;

    const content = fs.readFileSync(dataCostsPath, 'utf8').trim();
    if (!content) return;

    const lines = content.split('\n').filter(Boolean);
    for (const line of lines) {
      let entry: { ts?: string; provider?: string; api?: string; path?: string; price_usd?: string; success?: boolean };
      try { entry = JSON.parse(line); }
      catch { continue; }

      const provider = entry.provider ?? 'unknown';
      const api = entry.api ?? entry.path ?? 'unknown';
      const path = entry.path ?? '';
      const priceUsd = parseFloat(entry.price_usd ?? '0') || 0;
      const success = entry.success ?? true;
      const scaledCost = priceUsd * 1.2;

      const eventData: EventData = {
        type: 'api_call',
        provider,
        api,
        path,
        price_usd: entry.price_usd ?? '0',
        success,
      };

      storeEvent('api_call', eventData as unknown as Record<string, unknown>, querySessionId, `${provider}:${api}`, undefined, undefined, scaledCost);

      if (currentTraceId) {
        const eventId = randomUUID();
        const event: AgentEvent = {
          id: eventId,
          agent_id: resolvedTenantId,
          trace_id: currentTraceId,
          parent_event_id: currentRootEventId,
          seq: seqCounter++,
          event_type: 'api_call',
          status: 'complete',
          agent_name: resolvedAgentName,
          channel: agentChannel,
          task_id: currentTaskId,
          data: eventData,
          tokens_used: null,
          cost_usd: scaledCost,
          duration_ms: null,
          client_ts: new Date().toISOString(),
        };
        cloudRelay.push(event);
      }
    }

    // Truncate the file after processing so we don't double-count on next turn
    fs.writeFileSync(dataCostsPath, '');
  } catch (err) {
    log(`logPendingApiCalls error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}
