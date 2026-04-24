/**
 * Pepper Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { createHmac } from 'crypto';
import { query, HookCallback, PreCompactHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import * as telemetry from './telemetry.js';

let lastContextPrompt: string | null = null;

// ─── Human Approval ────────────────────────────────────────────────────────

// Tools that are always safe to auto-approve in write_actions mode
const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS',
  'Task', 'TaskOutput', 'TaskStop',
  'TodoWrite', 'ToolSearch', 'Skill',
]);

/**
 * Create a pending approval on the cloud and return its ID.
 * Returns null if the request fails (will cause canUseTool to deny).
 */
async function createApproval(
  cloudUrl: string,
  wsId: string,
  agentId: string,
  secret: string,
  toolName: string,
  toolInput: unknown,
  taskId: string | undefined,
): Promise<string | null> {
  const body = JSON.stringify({ tool_name: toolName, tool_input: toolInput ?? {}, task_id: taskId });
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  try {
    const res = await fetch(`${cloudUrl}/api/workspaces/${wsId}/agents/${agentId}/approval`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Event-Signature': sig },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.approval_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Poll the cloud for the approval decision.
 * Polls every 3s for up to 5 minutes, then returns 'timeout'.
 */
async function pollApproval(
  cloudUrl: string,
  wsId: string,
  agentId: string,
  secret: string,
  approvalId: string,
): Promise<'approved' | 'denied' | 'timeout'> {
  const deadline = Date.now() + 5 * 60 * 1000;
  const sig = createHmac('sha256', secret).update(approvalId).digest('hex');
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await fetch(
        `${cloudUrl}/api/workspaces/${wsId}/agents/${agentId}/approval/${approvalId}`,
        { headers: { 'X-Event-Signature': sig }, signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (data.status === 'approved') return 'approved';
      if (data.status === 'denied') return 'denied';
    } catch { /* network hiccup, keep polling */ }
  }
  return 'timeout';
}

type CanUseToolFn = (toolName: string, input: unknown) => Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }>;

/**
 * Build a canUseTool callback for the given approval mode.
 * Returns undefined for 'yolo' (caller uses bypassPermissions instead).
 */
function buildCanUseTool(
  mode: string,
  cloudUrl: string,
  wsId: string,
  agentId: string,
  secret: string,
  taskId: string | undefined,
): CanUseToolFn | undefined {
  if (mode === 'yolo' || !cloudUrl || !wsId || !agentId || !secret) return undefined;

  return async (toolName: string, input: unknown) => {
    const needsApproval =
      mode === 'always' ||
      (mode === 'write_actions' && !READ_ONLY_TOOLS.has(toolName));

    if (!needsApproval) return { behavior: 'allow' };

    log(`[approval] requesting approval for ${toolName}`);
    const approvalId = await createApproval(cloudUrl, wsId, agentId, secret, toolName, input, taskId);
    if (!approvalId) {
      log(`[approval] failed to create approval — denying ${toolName}`);
      return { behavior: 'deny', message: 'Could not reach approval service — tool call denied.' };
    }

    const decision = await pollApproval(cloudUrl, wsId, agentId, secret, approvalId);
    log(`[approval] ${toolName} → ${decision}`);

    if (decision === 'approved') return { behavior: 'allow' };
    const msg = decision === 'timeout'
      ? `Approval timed out after 5 minutes — ${toolName} denied.`
      : `User denied ${toolName}.`;
    return { behavior: 'deny', message: msg };
  };
}

// ──────────────────────────────────────────────────────────────────────────

async function fetchWorkspaceContext(taskTitle: string): Promise<string> {
  const cloudUrl = process.env.PEPPER_CLOUD_URL;
  const wsId = process.env.WORKSPACE_ID;
  const agentId = process.env.AGENT_ID;
  const secret = process.env.PEPPER_EVENT_SECRET;
  const skills = process.env.AGENT_SKILLS ?? '';

  // Only if workspace-memory skill is enabled
  if (!skills.includes('workspace-memory')) return '';
  if (!cloudUrl || !wsId || !agentId || !secret) return '';

  const payload = `${wsId}:${agentId}:${taskTitle}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  const params = new URLSearchParams({ task: taskTitle, agent_id: agentId });

  try {
    const resp = await fetch(
      `${cloudUrl}/api/workspaces/${wsId}/memory/context?${params}`,
      {
        headers: { 'X-Event-Signature': sig },
        signal: AbortSignal.timeout(2000),
      }
    );
    if (!resp.ok) return '';
    const data = await resp.json();
    return data.context ?? '';
  } catch {
    return ''; // Timeout or network error — proceed without context
  }
}

interface ProcessedAttachment {
  type: 'image' | 'document' | 'file';
  mimeType: string;
  base64: string;
  filename?: string;
}

interface ContainerInput {
  prompt: string;
  attachments?: ProcessedAttachment[];
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

// SDKUserMessage is imported from @anthropic-ai/claude-agent-sdk above

const MCP_JSON_PATH = '/home/node/.claude/.mcp.json';
const IPC_INPUT_DIR = process.env.PEPPER_IPC_INPUT || '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const WORKSPACE_GROUP = process.env.PEPPER_WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_GLOBAL = process.env.PEPPER_WORKSPACE_GLOBAL || '/workspace/global';
const WORKSPACE_EXTRA = process.env.PEPPER_WORKSPACE_EXTRA || '/workspace/extra';
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(content: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---PEPPER_OUTPUT_START---';
const OUTPUT_END_MARKER = '---PEPPER_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = path.join(WORKSPACE_GROUP, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

// Default secrets to strip from Bash tool subprocess environments.
// Additional keys are passed dynamically via containerInput.secretKeyNames.
const DEFAULT_SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

// Env vars that CLI tools need at runtime — do NOT unset these.
// These are secrets, but they must remain visible so that tools like
// `gh`, `aws`, `supabase`, and skill-specific CLIs can authenticate.
const CLI_PASSTHROUGH_VARS = new Set([
  // GitHub
  'GH_TOKEN',
  'GITHUB_TOKEN',
  // AWS
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_DEFAULT_REGION',
  // Supabase
  'SUPABASE_ACCESS_TOKEN',   // management API (projects list, link)
  'SUPABASE_URL',
  'SUPABASE_DB_PASSWORD',    // direct postgres (inspect db, db execute, db dump)
  'SUPABASE_SERVICE_ROLE_KEY', // REST API (optional)
  // Vercel
  'VERCEL_TOKEN',            // vercel CLI auth
  'VERCEL_ORG_ID',           // optional: pin team without --scope
  'VERCEL_PROJECT_ID',       // optional: pin project without linking
  // Composio
  'COMPOSIO_API_KEY',        // composio-tool API auth
  'COMPOSIO_USER_ID',        // composio-tool user scoping
  // Skill-injected platform API keys (used by curl in skill instructions)
  'EXA_API_KEY',             // market-analysis skill (Exa search)
  'XAI_API_KEY',             // x-search skill (Grok/X search)
  // Observability (non-secret metadata — agents may use for self-diagnostics)
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_BASE_URL',
  // Model alias overrides — must land in process.env for Claude Code SDK to honor them
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  // Marketing data sources (platform keys — used by orth/exa/parallel/perplexity wrappers via Bash)
  'ORTHOGONAL_API_KEY',      // orth wrapper → Orthogonal unified API
  'PARALLEL_API_KEY',        // parallel wrapper → Parallel deep research
  'PERPLEXITY_API_KEY',      // perplexity wrapper → Perplexity Sonar API
  // Cold email (B2B ICPs only)
  'SMARTLEAD_API_KEY',       // smartlead-campaign-manager skill
  // Ads APIs (opt-in per ICP)
  'META_ACCESS_TOKEN',       // meta-ads-manager skill
  'META_AD_ACCOUNT_ID',      // meta-ads-manager skill (non-secret but needed by curl)
  'GOOGLE_ADS_DEVELOPER_TOKEN', // google-ads-manager skill
  'GOOGLE_ADS_CLIENT_ID',    // google-ads-manager skill
  'TWITTER_ADS_API_KEY',     // twitter-ads-manager skill
  'TWITTER_ADS_SECRET',      // twitter-ads-manager skill
  'TIKTOK_ADS_ACCESS_TOKEN', // tiktok-ads-manager skill
]);

function createSanitizeBashHook(extraSecretKeys: string[] = []): HookCallback {
  const allSecretKeys = [...new Set([
    ...DEFAULT_SECRET_ENV_VARS,
    ...extraSecretKeys,
  ])].filter(key => !CLI_PASSTHROUGH_VARS.has(key));

  log(`[sanitize-hook] unset list (${allSecretKeys.length} keys): ${allSecretKeys.join(', ')}`);
  log(`[sanitize-hook] GH_TOKEN in extraSecretKeys: ${extraSecretKeys.includes('GH_TOKEN')}, kept (not unset): ${!allSecretKeys.includes('GH_TOKEN')}`);

  return async (input, _toolUseId, _context) => {
    const preInput = input as PreToolUseHookInput;
    const command = (preInput.tool_input as { command?: string })?.command;
    if (!command) return {};

    const unsetPrefix = `unset ${allSecretKeys.join(' ')} 2>/dev/null; `;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preInput.tool_input as Record<string, unknown>),
          command: unsetPrefix + command,
        },
      },
    };
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  initialContent: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(initialContent);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      telemetry.emitUserMessage(text);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let lastAssistantText: string | null = null;

  // Load additional MCP servers from .mcp.json (synced from host)
  const extraMcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
  const extraMcpToolPatterns: string[] = [];
  if (fs.existsSync(MCP_JSON_PATH)) {
    try {
      const mcpJson = JSON.parse(fs.readFileSync(MCP_JSON_PATH, 'utf-8'));
      for (const [name, config] of Object.entries(mcpJson.mcpServers || {})) {
        const cfg = config as { command: string; args?: string[]; env?: Record<string, string> };
        const resolvedEnv: Record<string, string> = {};
        for (const [key, val] of Object.entries(cfg.env || {})) {
          const match = val.match(/^\$\{(.+)\}$/);
          if (match && sdkEnv[match[1]]) resolvedEnv[key] = sdkEnv[match[1]]!;
          else if (!val.startsWith('${')) resolvedEnv[key] = val;
        }
        extraMcpServers[name] = { command: cfg.command, args: cfg.args || [], env: resolvedEnv };
        extraMcpToolPatterns.push(`mcp__${name}__*`);
        log(`MCP server from .mcp.json: ${name} (${cfg.command})`);
      }
    } catch (err) {
      log(`Failed to read .mcp.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Composio MCP tool servers (remote HTTP, managed by Pepper Cloud) ──
  const composioMcpUrls: Record<string, string> = process.env.COMPOSIO_MCP_URLS
    ? (() => { try { return JSON.parse(process.env.COMPOSIO_MCP_URLS); } catch { return {}; } })()
    : {};
  const composioMcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }> = {};
  const composioToolPatterns: string[] = [];

  for (const [app, url] of Object.entries(composioMcpUrls)) {
    composioMcpServers[app] = {
      type: 'http',
      url,
      headers: { 'x-api-key': sdkEnv.COMPOSIO_API_KEY || '' },
    };
    composioToolPatterns.push(`mcp__${app}__*`);
    log(`[composio] MCP server: ${app}`);
  }

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = path.join(WORKSPACE_GLOBAL, 'CLAUDE.md');
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Web search guidance — injected for all agents (main + sub).
  // WebSearch/WebFetch built-ins are not in allowedTools because they route
  // through OpenRouter and require direct Anthropic API access to work.
  const webSearchGuidance = `## Web Search & Research

The WebSearch and WebFetch built-in tools are NOT available. Use Bash-based alternatives instead:

- **\`exa-search\`** — structured web search via Exa API (EXA_API_KEY is pre-configured)
  - \`exa-search "query"\` — general search
  - \`exa-search "query" --domain reddit.com,producthunt.com\` — domain-filtered
  - \`exa-search "query" --since 2025-01-01 --summary\` — recent results with summaries
  - \`exa-search --help\` — full options

- **\`perplexity\`** — AI-grounded web search via Perplexity Sonar (PERPLEXITY_API_KEY is pre-configured)
  - \`perplexity "query"\` — grounded answer with citations (default: sonar-pro)
  - \`perplexity "query" --model sonar-deep-research\` — comprehensive multi-step research
  - \`perplexity --help\` — full options

- **\`parallel\`** — deep research via Parallel AI (PARALLEL_API_KEY is pre-configured)
  - \`parallel /task '{"query":"...", "mode":"lite"}'\` — research task

Never attempt to call WebSearch or WebFetch — they are not allowed and will error.`;

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = WORKSPACE_EXTRA;
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  const modelOverride = sdkEnv.ANTHROPIC_MODEL;

  const promptForTelemetry = initialContent;

  telemetry.onQueryStart(promptForTelemetry, sessionId);

  const approvalMode = process.env.AGENT_APPROVAL_MODE ?? 'yolo';
  const approvalCloudUrl = process.env.PEPPER_CLOUD_URL ?? '';
  const approvalWsId = process.env.WORKSPACE_ID ?? '';
  const approvalAgentId = process.env.AGENT_ID ?? '';
  const approvalSecret = process.env.PEPPER_EVENT_SECRET ?? '';
  const approvalTaskId = process.env.TASK_ID || undefined;

  const canUseTool = buildCanUseTool(approvalMode, approvalCloudUrl, approvalWsId, approvalAgentId, approvalSecret, approvalTaskId);

  for await (const message of query({
    prompt: stream,
    options: {
      ...(modelOverride ? { model: modelOverride } : {}),
      cwd: WORKSPACE_GROUP,
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: [webSearchGuidance, globalClaudeMd].filter(Boolean).join('\n\n'),
      },
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__pepper__*',
        ...extraMcpToolPatterns,
        ...composioToolPatterns,
      ],
      env: sdkEnv,
      ...(canUseTool
        ? { canUseTool }
        : { permissionMode: 'bypassPermissions' as const, allowDangerouslySkipPermissions: true }),
      settingSources: ['project', 'user'],
      mcpServers: {
        pepper: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            PEPPER_CHAT_JID: containerInput.chatJid,
            PEPPER_GROUP_FOLDER: containerInput.groupFolder,
            PEPPER_IS_MAIN: containerInput.isMain ? '1' : '0',
            PEPPER_CLOUD_URL: process.env.PEPPER_CLOUD_URL || '',
            PEPPER_EVENT_SECRET: process.env.PEPPER_EVENT_SECRET || '',
            TENANT_ID: process.env.TENANT_ID || '',
            TASK_ID: process.env.TASK_ID || '',
          },
        },
        ...extraMcpServers,
        ...composioMcpServers,
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [createSanitizeBashHook((containerInput as unknown as Record<string, unknown>).secretKeyNames as string[] || [])] }],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    // Log content details for assistant messages (tool calls + text)
    if (message.type === 'assistant' && 'message' in message) {
      const msg = (message as { message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }> } }).message;
      if (msg?.content) {
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            const inputStr = JSON.stringify(block.input || {});
            log(`  → tool_use: ${block.name} | input: ${inputStr.slice(0, 200)}`);
          } else if (block.type === 'text' && block.text) {
            log(`  → text: ${block.text.slice(0, 200)}`);
          }
        }
      }
    }

    // Log tool results (user messages carrying tool_result blocks)
    if (message.type === 'user' && 'message' in message) {
      const msg = (message as { message?: { content?: Array<{ type: string; tool_use_id?: string; content?: string | Array<{ type: string; text?: string }>; is_error?: boolean }> } }).message;
      if (msg?.content) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            const text = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map(c => c.text || '').join('')
                : '';
            const status = block.is_error ? 'error' : 'ok';
            log(`  ← tool_result [${block.tool_use_id?.slice(-8) || '?'}] status=${status}: ${text.slice(0, 200)}`);
          }
        }
      }
    }

    telemetry.onMessage(message as unknown as Record<string, unknown>);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    // Capture text from assistant messages as fallback for when result.result is null
    if (message.type === 'assistant' && 'message' in message) {
      const msg = (message as { message?: { content?: Array<{ type: string; text?: string }> } }).message;
      if (msg?.content) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            lastAssistantText = block.text;
          }
        }
      }
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      const finalText = textResult || lastAssistantText || null;
      log(`Result #${resultCount}: subtype=${message.subtype}${finalText ? ` text=${finalText.slice(0, 200)}` : ''}`);
      writeOutput({
        status: 'success',
        result: finalText,
        newSessionId
      });
      lastAssistantText = null;
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);

  await telemetry.onQueryEnd();

  // Flush any data API costs logged to .data-costs.jsonl during this query
  const dataCostsPath = path.join(WORKSPACE_GROUP, '.data-costs.jsonl');
  telemetry.logPendingApiCalls(dataCostsPath);

  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // On Railway, secrets are passed via stdin (no credential proxy).
  // Inject them into the SDK environment so the agent can authenticate.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  if (containerInput.secrets) {
    const cliVarsInjected: string[] = [];
    for (const [key, value] of Object.entries(containerInput.secrets)) {
      sdkEnv[key] = value;
      // Inject CLI tool credentials into process.env so Bash child
      // processes inherit them (SDK env option only affects API calls).
      if (CLI_PASSTHROUGH_VARS.has(key)) {
        process.env[key] = value;
        cliVarsInjected.push(key);
      }
    }
    log(`[env-inject] CLI vars injected into process.env: ${cliVarsInjected.join(', ') || '(none)'}`);
    log(`[env-inject] GH_TOKEN in secrets: ${!!containerInput.secrets.GH_TOKEN}, length: ${containerInput.secrets.GH_TOKEN?.length ?? 0}`);
    log(`[env-inject] GH_TOKEN in process.env after inject: ${!!process.env.GH_TOKEN}`);
    log(`[env-inject] GH_TOKEN in sdkEnv: ${!!sdkEnv.GH_TOKEN}`);
    // Initialize telemetry (Langfuse + SQLite)
    await telemetry.init({
      secrets: containerInput.secrets as Record<string, string>,
      groupFolder: containerInput.groupFolder,
      chatJid: containerInput.chatJid,
      assistantName: containerInput.assistantName,
      dbPath: path.join(process.env.PEPPER_WORKSPACE_GROUP || '/workspace/group', 'agent_events.db'),
    });

    // Set channel for observability events
    const channel = process.env.TELEGRAM_BOT_TOKEN ? 'telegram'
      : process.env.SLACK_BOT_TOKEN ? 'slack'
      : process.env.DISCORD_BOT_TOKEN ? 'discord'
      : 'unknown';
    telemetry.setChannel(channel);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial content — multimodal if attachments present, plain text otherwise
  let promptText = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    promptText = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${promptText}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    promptText += '\n' + pending.join('\n');
  }

  // Write ALL attachments to workspace — the SDK's Read tool handles images,
  // PDFs, and text files natively. No multimodal content blocks needed.
  const fileNotes: string[] = [];
  if (containerInput.attachments?.length) {
    const fs = await import('fs');
    const path = await import('path');
    const attachDir = path.join(process.cwd(), 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });
    for (const att of containerInput.attachments) {
      const filename = att.filename || `attachment.${att.mimeType.split('/')[1] || 'bin'}`;
      const filePath = path.join(attachDir, filename);
      fs.writeFileSync(filePath, Buffer.from(att.base64, 'base64'));
      fileNotes.push(`[Attached: ./attachments/${filename}]`);
    }
  }
  const fileNoteSuffix = fileNotes.length > 0
    ? '\n\n' + fileNotes.join('\n') + '\nUse the Read tool to view these files.'
    : '';

  const initialContent = promptText + fileNoteSuffix;

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      // Inject workspace context on task switch (new prompt not yet fetched)
      if (promptText !== lastContextPrompt) {
        const wsContext = await fetchWorkspaceContext(promptText);
        if (wsContext) {
          promptText = `[Workspace Context]\n${wsContext}\n[End Workspace Context]\n\n${promptText}`;
          log(`[workspace-memory] context injected (${wsContext.length} chars)`);
        }
        lastContextPrompt = promptText;
      }

      // First query uses multimodal initialContent; IPC followups are always plain text
      const queryContent = resumeAt === undefined ? initialContent : promptText;
      const queryResult = await runQuery(queryContent, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      promptText = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  } finally {
    await telemetry.shutdown();
  }
}

main();
