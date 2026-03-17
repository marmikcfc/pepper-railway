# Agent Telemetry Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace auto-instrumentation with manual OTEL spans and SQLite event logging so Langfuse traces appear in real-time with full input/output/tool/subagent data.

**Architecture:** New `telemetry.ts` module receives every SDK message from the query loop, creates/ends OTEL spans per tool call and subagent, writes events to SQLite. The agent-runner's `index.ts` calls `telemetry.onMessage()` for each message — clean observer pattern, no coupling.

**Tech Stack:** `@opentelemetry/api`, `@langfuse/otel`, `@opentelemetry/sdk-node`, `better-sqlite3`

**Spec:** See discussion above — SDK message types confirmed from `platform.claude.com/docs/en/agent-sdk/typescript`

---

## Chunk 1: Telemetry Module + Integration

### File Structure

```
container/agent-runner/src/
├── index.ts           # MODIFY: remove auto-instrumentation, add telemetry.onMessage() calls
├── telemetry.ts       # CREATE: span management + SQLite event logging
└── ipc-mcp-stdio.ts   # UNTOUCHED
```

### Task 1: Create telemetry.ts — OTEL setup and public API

**Files:**
- Create: `container/agent-runner/src/telemetry.ts`

- [ ] **Step 1: Create the module with OTEL initialization**

Create `container/agent-runner/src/telemetry.ts`:

```typescript
/**
 * Agent telemetry — manual OTEL spans + SQLite event logging.
 * Receives SDK messages from the query loop and creates traces.
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
    process.env.LANGFUSE_BASE_URL = config.secrets.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com';
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

    const sdk = new NodeSDK({
      spanProcessors: [proc],
    });
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

  // Start root AGENT span
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

  // SQLite
  storeEvent('query_start', { prompt }, sessionId);
}

/**
 * Called for every SDK message yielded by the query generator.
 */
export function onMessage(message: Record<string, unknown>): void {
  const type = message.type as string;

  // system/init — capture session ID and model
  if (type === 'system' && message.subtype === 'init') {
    const sid = message.session_id as string;
    const model = message.model as string;
    querySessionId = sid;
    queryModel = model;
    rootSpan?.setAttribute('session.id', sid);
    rootSpan?.setAttribute('llm.model_name', model);
    return;
  }

  // assistant message — extract text, tool calls, model, tokens
  if (type === 'assistant' && message.message) {
    const msg = message.message as Record<string, unknown>;
    const content = msg.content as Array<Record<string, unknown>> | undefined;
    const model = msg.model as string | undefined;
    const usage = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    const parentToolUseId = message.parent_tool_use_id as string | null;

    if (model && !queryModel) {
      queryModel = model;
      rootSpan?.setAttribute('llm.model_name', model);
    }

    if (content) {
      for (const block of content) {
        // Text content
        if (block.type === 'text' && block.text) {
          lastAssistantText = block.text as string;
        }

        // Tool use — start a TOOL span
        if (block.type === 'tool_use') {
          const toolName = block.name as string;
          const toolInput = block.input as Record<string, unknown>;
          const toolUseId = block.id as string;

          if (tracer && rootSpan) {
            const toolSpan = tracer.startSpan(toolName, {
              attributes: {
                'openinference.span.kind': 'TOOL',
                'tool.name': toolName,
                'tool.parameters': JSON.stringify(toolInput),
                'input.value': JSON.stringify(toolInput),
                'input.mime_type': 'application/json',
              },
            }, undefined);
            pendingTools.set(toolUseId, toolSpan);
          }

          storeEvent('tool_call', {
            tool_name: toolName,
            tool_input: toolInput,
            tool_use_id: toolUseId,
          }, querySessionId, toolName);
        }
      }
    }
    return;
  }

  // user message with tool results — end matching TOOL span
  if (type === 'user' && message.tool_use_result !== undefined) {
    // The parent_tool_use_id tells us which tool call this result is for
    const parentId = message.parent_tool_use_id as string | null;
    if (parentId) {
      const toolSpan = pendingTools.get(parentId);
      if (toolSpan) {
        const resultStr = typeof message.tool_use_result === 'string'
          ? message.tool_use_result
          : JSON.stringify(message.tool_use_result);
        toolSpan.setAttribute('output.value', resultStr.slice(0, 10000));
        toolSpan.setAttribute('output.mime_type', 'application/json');
        toolSpan.end();
        pendingTools.delete(parentId);
        flush();
      }
    }

    storeEvent('tool_result', {
      parent_tool_use_id: parentId,
      result: message.tool_use_result,
    }, querySessionId);
    return;
  }

  // task_started — subagent started
  if (type === 'system' && message.subtype === 'task_started') {
    const taskId = message.task_id as string;
    const description = message.description as string;

    if (tracer && rootSpan) {
      const subSpan = tracer.startSpan(`Subagent: ${description}`, {
        attributes: {
          'openinference.span.kind': 'AGENT',
          'input.value': description,
          'task.id': taskId,
        },
      }, undefined);
      pendingSubagents.set(taskId, subSpan);
    }

    storeEvent('subagent_start', {
      task_id: taskId,
      description,
      task_type: message.task_type,
    }, querySessionId);
    return;
  }

  // task_progress — subagent progress
  if (type === 'system' && message.subtype === 'task_progress') {
    const taskId = message.task_id as string;
    const subSpan = pendingSubagents.get(taskId);
    const usage = message.usage as { total_tokens?: number; tool_uses?: number; duration_ms?: number } | undefined;
    if (subSpan && usage) {
      subSpan.setAttribute('llm.token_count.total', usage.total_tokens || 0);
    }
    return;
  }

  // task_notification — subagent completed/failed
  if (type === 'system' && message.subtype === 'task_notification') {
    const taskId = message.task_id as string;
    const status = message.status as string;
    const summary = message.summary as string;
    const usage = message.usage as { total_tokens?: number; tool_uses?: number; duration_ms?: number } | undefined;

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

    storeEvent('subagent_end', {
      task_id: taskId,
      status,
      summary,
      usage,
    }, querySessionId);
    return;
  }

  // result — end root span
  if (type === 'result') {
    const resultText = message.result as string | null;
    const finalText = resultText || lastAssistantText || null;
    const totalCost = message.total_cost_usd as number | undefined;
    const usage = message.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    const durationMs = message.duration_ms as number | undefined;
    const modelUsage = message.modelUsage as Record<string, unknown> | undefined;

    if (rootSpan) {
      if (finalText) {
        rootSpan.setAttribute('output.value', finalText);
        rootSpan.setAttribute('output.mime_type', 'text/plain');
      }
      if (usage) {
        rootSpan.setAttribute('llm.token_count.prompt', usage.input_tokens || 0);
        rootSpan.setAttribute('llm.token_count.completion', usage.output_tokens || 0);
        rootSpan.setAttribute('llm.token_count.total', (usage.input_tokens || 0) + (usage.output_tokens || 0));
      }
      if (totalCost !== undefined) {
        rootSpan.setAttribute('llm.cost.total', totalCost);
      }
      if (queryModel) {
        rootSpan.setAttribute('llm.model_name', queryModel);
      }
      rootSpan.end();
      rootSpan = null;
      // Don't flush here — onQueryEnd will flush after a brief delay
    }

    storeEvent('result', {
      subtype: message.subtype,
      result: finalText,
      total_cost_usd: totalCost,
      usage,
      model_usage: modelUsage,
      duration_ms: durationMs,
    }, querySessionId, undefined, usage?.input_tokens, usage?.output_tokens, totalCost, durationMs);
    return;
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
  await new Promise(r => setTimeout(r, 100));
  await flush();
}

/**
 * Shutdown — flush and close everything.
 */
export async function shutdown(): Promise<void> {
  await onQueryEnd();
  if (otelSdk) {
    try { await otelSdk.shutdown(); } catch {}
  }
  if (db) {
    try { db.close(); } catch {}
  }
}

// --- Internal helpers ---

async function flush(): Promise<void> {
  if (!spanProcessor) return;
  try {
    await spanProcessor.forceFlush();
  } catch { /* non-fatal */ }
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
    db.prepare(`
      INSERT INTO agent_events (session_id, event_type, tool_name, data, input_tokens, output_tokens, cost_usd, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    log(`SQLite write error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add container/agent-runner/src/telemetry.ts
git commit -m "feat: add telemetry module with manual OTEL spans and SQLite event logging"
```

---

### Task 2: Update package.json dependencies

**Files:**
- Modify: `container/agent-runner/package.json`

- [ ] **Step 1: Remove auto-instrumentation, add new deps**

In `container/agent-runner/package.json`, update dependencies:

Remove:
- `"@arizeai/openinference-instrumentation-claude-agent-sdk": "latest"`

Add:
- `"@opentelemetry/api": "latest"`
- `"better-sqlite3": "^11.8.1"`

Keep:
- `"@langfuse/otel": "latest"`
- `"@opentelemetry/sdk-node": "latest"`

Also add to devDependencies:
- `"@types/better-sqlite3": "^7.6.12"`

- [ ] **Step 2: Commit**

```bash
git add container/agent-runner/package.json
git commit -m "chore: update agent-runner deps — remove auto-instrumentation, add otel api + better-sqlite3"
```

---

### Task 3: Integrate telemetry into index.ts

**Files:**
- Modify: `container/agent-runner/src/index.ts`

- [ ] **Step 1: Remove all Langfuse/OTEL code from index.ts**

Remove:
- The `import * as ClaudeAgentSDKModule` import
- The `ClaudeAgentSDK = { ...ClaudeAgentSDKModule }` mutable copy
- The entire `initTelemetry()` function
- The `flushTelemetry()` function
- The `otelSdk`, `otelSpanProcessor` variables
- The `getQuery()` function
- The `flushTelemetry().then(...)` call in `writeOutput()`

Replace the import with:
```typescript
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
```

Add:
```typescript
import * as telemetry from './telemetry.js';
```

- [ ] **Step 2: Initialize telemetry in main()**

After `containerInput.secrets` is loaded and `sdkEnv` is populated, add:

```typescript
await telemetry.init({
  secrets: containerInput.secrets as Record<string, string>,
  groupFolder: containerInput.groupFolder,
  chatJid: containerInput.chatJid,
  assistantName: containerInput.assistantName,
  dbPath: path.join(process.env.NANOCLAW_WORKSPACE_GROUP || '/workspace/group', 'agent_events.db'),
});
```

- [ ] **Step 3: Add telemetry calls to runQuery()**

Before the `for await` loop:
```typescript
telemetry.onQueryStart(prompt, sessionId);
```

Inside the `for await` loop, right after the `messageCount++` line:
```typescript
telemetry.onMessage(message as unknown as Record<string, unknown>);
```

After the `for await` loop (replace the existing `await new Promise(r => setTimeout(r, 200)); await flushTelemetry();`):
```typescript
await telemetry.onQueryEnd();
```

- [ ] **Step 4: Update the finally block**

Replace:
```typescript
if (otelSdk) {
  try {
    log('Flushing Langfuse telemetry...');
    await otelSdk.shutdown();
    log('Langfuse telemetry flushed');
  } catch (err) {
    log(`Langfuse flush error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

With:
```typescript
await telemetry.shutdown();
```

- [ ] **Step 5: Remove flushTelemetry from writeOutput**

Revert `writeOutput` to its simple form:
```typescript
function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}
```

- [ ] **Step 6: Build and verify**

```bash
cd /Users/marmikpandya/nanoclaw/nanoclaw-railway
npm run build
```

Expected: Build succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat: integrate telemetry module — remove auto-instrumentation, add onMessage() observer"
```

---

### Task 4: Verify Dockerfile compatibility

**Files:**
- Review: `Dockerfile.railway`

- [ ] **Step 1: Check that better-sqlite3 builds in Docker**

`better-sqlite3` requires native compilation. The Dockerfile uses `node:22-slim` which should have the build tools. But verify:

The agent-runner stage in `Dockerfile.railway` does:
```dockerfile
COPY container/agent-runner/package*.json ./
RUN npm install
```

`better-sqlite3` needs `python3` and `make` for native compilation. The final stage installs `python3` (for system-config-printer). But the `agent-builder` stage uses `node:22-slim` which may not have build tools.

If build fails, add to `Dockerfile.railway` agent-builder stage:
```dockerfile
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
```

Before `RUN npm install`.

- [ ] **Step 2: Commit if changes needed**

```bash
git add Dockerfile.railway
git commit -m "fix: add build tools for better-sqlite3 in agent-builder stage"
```

---

### Task 5: Push and test

- [ ] **Step 1: Push to GitHub**

```bash
git push origin main
```

- [ ] **Step 2: Wait for Railway to rebuild**

Monitor Railway build logs for success.

- [ ] **Step 3: Send a test message to the bot**

Send "Hi, what tools do you have?" to the Telegram bot.

- [ ] **Step 4: Verify in Langfuse**

Check Langfuse dashboard within 30 seconds. Expected:
- Trace appears with name `ClaudeAgent.query`
- Input shows the user's message
- Output shows the agent's response
- Token counts and cost visible
- Model name visible
- Any tool calls appear as child TOOL spans

- [ ] **Step 5: Verify SQLite**

SSH into Railway container or check logs for:
- `SQLite event store initialized`
- No SQLite write errors

The `agent_events.db` file should exist at the group workspace path.
