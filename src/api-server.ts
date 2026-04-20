import http from 'http';
import fs from 'fs';
import path from 'path';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

import { logger } from './logger.js';
import { GROUPS_DIR } from './config.js';
import { downloadBuffer, processImage, processPdf } from './media.js';
import { Channel } from './types.js';
import { storeMessage, getAllRegisteredGroups, deleteSession, clearTaskContextCache } from './db.js';
import { enableIntegration, disableIntegration } from './integrations/activator.js';

// Lazily resolved to avoid circular import at module load time
let _addAllowedNumber: ((phone: string) => void) | undefined;
let _removeAllowedNumber: ((phone: string) => void) | undefined;

export function setAllowedNumberFns(
  add: (phone: string) => void,
  remove: (phone: string) => void,
): void {
  _addAllowedNumber = add;
  _removeAllowedNumber = remove;
}

// Lazily resolved callbacks for webchat JID handling
let _enqueueWebchat: ((jid: string) => void) | undefined;
let _getWebchatChannel: (() => import('./channels/webchat.js').WebchatChannel | undefined) | undefined;

export function setWebchatFns(
  enqueue: (jid: string) => void,
  getChannel: () => import('./channels/webchat.js').WebchatChannel | undefined,
): void {
  _enqueueWebchat = enqueue;
  _getWebchatChannel = getChannel;
}

let _schedulerTick: (() => Promise<void>) | undefined;
let _onSessionReset: ((folder: string) => void) | undefined;

export function setSchedulerTickFn(fn: () => Promise<void>): void {
  _schedulerTick = fn;
}

export function setSessionResetFn(fn: (folder: string) => void): void {
  _onSessionReset = fn;
}

let connectedChannels: Channel[] = [];
const startTime = Date.now();

export function setChannels(channels: Channel[]): void {
  connectedChannels = channels;
}

function verifyHmac(body: string, signatureHeader: string | undefined): boolean {
  const secret = process.env.PEPPER_EVENT_SECRET;
  if (!secret) {
    logger.warn('PEPPER_EVENT_SECRET not set — rejecting command request');
    return false;
  }
  if (!signatureHeader) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  if (expected.length !== signatureHeader.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const MAX_BODY_BYTES = 512 * 1024; // 512KB — webhook payloads can be large

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handleHealth(res: http.ServerResponse): Promise<void> {
  const channelNames = connectedChannels
    .filter((ch) => ch.isConnected())
    .map((ch) => ch.name);
  json(res, 200, {
    status: 'ok',
    channels: channelNames,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
}

async function handleRefreshPairing(_body: unknown, res: http.ServerResponse): Promise<void> {
  const waChannel = connectedChannels.find((ch) => ch.name === 'whatsapp');
  if (!waChannel) {
    json(res, 404, { error: 'WhatsApp channel not active' });
    return;
  }
  if (!waChannel.refreshPairing) {
    json(res, 501, { error: 'Channel does not support pairing refresh' });
    return;
  }
  // Fire-and-forget: pairing requires user interaction (entering code on phone)
  // which takes longer than the proxy timeout. Return immediately and let the
  // new pairing code arrive via the existing pushToCloud → Realtime path.
  waChannel.refreshPairing().catch((err) => {
    logger.error({ err }, 'Failed to refresh pairing');
  });
  json(res, 200, { success: true, message: 'Pairing refresh initiated' });
}

async function handleEnableIntegration(body: unknown, res: http.ServerResponse): Promise<void> {
  const { integrationId } = body as { integrationId: string };
  if (!integrationId) { json(res, 400, { error: 'integrationId required' }); return; }
  enableIntegration(integrationId);
  json(res, 200, { success: true });
}

async function handleDisableIntegration(body: unknown, res: http.ServerResponse): Promise<void> {
  const { integrationId } = body as { integrationId: string };
  if (!integrationId) { json(res, 400, { error: 'integrationId required' }); return; }
  disableIntegration(integrationId);
  json(res, 200, { success: true });
}

async function handleWebhookEvent(body: unknown, res: http.ServerResponse): Promise<void> {
  const { integrationId, eventType, payload } = body as {
    integrationId: string;
    eventType: string;
    payload: unknown;
  };

  // Webchat path: bypass groupEntries lookup, store directly to admin@pepper
  if (integrationId === 'webchat') {
    const { content, traceId, task_id, attachments: rawAttachments } = (payload as {
      content?: string;
      traceId: string;
      task_id?: string;
      attachments?: { url: string; mimeType: string; filename?: string }[];
    });

    // Download and process any attachments (images/PDFs)
    const processedAttachments: import('./media.js').ProcessedAttachment[] = [];
    if ((rawAttachments ?? []).length > 0) {
      logger.info({ count: rawAttachments!.length }, 'Downloading webchat attachments');
    }
    for (const att of rawAttachments ?? []) {
      try {
        logger.info({ mimeType: att.mimeType, filename: att.filename }, 'Downloading attachment');
        const buffer = await downloadBuffer(att.url);
        logger.info({ mimeType: att.mimeType, filename: att.filename, bytes: buffer.length }, 'Attachment downloaded');
        const processed = att.mimeType === 'application/pdf'
          ? processPdf(buffer, att.filename)
          : await processImage(buffer, att.mimeType, att.filename);
        logger.info({ type: processed.type, filename: processed.filename, base64Len: processed.base64.length }, 'Attachment processed');
        processedAttachments.push(processed);
      } catch (err) {
        logger.warn({ err, url: att.url }, 'Failed to process webchat attachment');
      }
    }
    logger.info(
      { requested: (rawAttachments ?? []).length, processed: processedAttachments.length },
      'Attachment processing complete',
    );

    const rawContent = content || processedAttachments.map((a) =>
      a.type === 'image' ? '[Image]' : '[PDF]'
    ).join(' ') || '';
    // Context is now pulled by Railway on-demand (context-fetcher.ts),
    // no longer embedded in stored messages.
    const messageContent = rawContent;

    storeMessage({
      id: randomUUID(),
      chat_jid: 'admin@pepper',
      sender: 'dashboard-owner',
      sender_name: 'You',
      content: messageContent,
      timestamp: new Date().toISOString(),
      is_from_me: true,
      is_bot_message: false,
      attachments: processedAttachments.length ? processedAttachments : undefined,
    });

    // Queue the trace ID on the channel BEFORE enqueueing. Using incomingTraceId
    // (not currentTraceId) keeps the handoff separate from the restore that
    // processGroupMessages performs just before sendMessage, preventing a new
    // webhook from overwriting a mid-flight run's traceId.
    // task_id is always a real UUID from the cloud (get-or-create misc task),
    // so no sentinel needed here.
    const channel = _getWebchatChannel?.();
    if (channel) {
      channel.incomingTraceIds.push(traceId);
      channel.incomingTaskIds.push(task_id ?? null);
    }

    _enqueueWebchat?.('admin@pepper');
    json(res, 200, { ok: true });
    return;
  }

  // Deliver webhook to first registered group (single-tenant Railway deploys typically have one)
  const groups = getAllRegisteredGroups();
  const groupEntries = Object.entries(groups);
  if (groupEntries.length === 0) {
    logger.warn({ integrationId }, 'Webhook received but no group registered');
    json(res, 200, { ok: true }); // don't error — agent may not have a group yet
    return;
  }

  const [mainJid] = groupEntries[0];
  storeMessage({
    id: randomUUID(),
    chat_jid: mainJid,
    sender: `webhook:${integrationId}`,
    sender_name: integrationId,
    content: `[${integrationId} webhook: ${eventType}]\n\n${JSON.stringify(payload, null, 2)}`,
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: false,
  });

  json(res, 200, { ok: true });
}

async function handleAllowNumber(body: unknown, res: http.ServerResponse): Promise<void> {
  const payload = body as Record<string, unknown>;
  const phone = payload?.phone;
  if (typeof phone !== 'string' || !phone) {
    json(res, 400, { error: 'Missing phone in payload' });
    return;
  }
  if (_addAllowedNumber) {
    _addAllowedNumber(phone);
    logger.info({ phone }, 'Added phone to WhatsApp whitelist');
    json(res, 200, { success: true });
  } else {
    json(res, 503, { error: 'Whitelist not yet initialised' });
  }
}

async function handleRemoveNumber(body: unknown, res: http.ServerResponse): Promise<void> {
  const payload = body as Record<string, unknown>;
  const phone = payload?.phone;
  if (typeof phone !== 'string' || !phone) {
    json(res, 400, { error: 'Missing phone in payload' });
    return;
  }
  if (_removeAllowedNumber) {
    _removeAllowedNumber(phone);
    logger.info({ phone }, 'Removed phone from WhatsApp whitelist');
    json(res, 200, { success: true });
  } else {
    json(res, 503, { error: 'Whitelist not yet initialised' });
  }
}

async function handleSendFile(body: unknown, res: http.ServerResponse): Promise<void> {
  const p = body as {
    artifact_id?: string;
    filename?: string;
    mime_type?: string;
    ephemeral_url?: string;
    chat_jid?: string;
    channel?: string;
  };

  if (!p.ephemeral_url || !p.chat_jid || !p.filename) {
    json(res, 400, { error: 'Missing ephemeral_url, chat_jid, or filename' });
    return;
  }

  // Find the right channel — prefer the specified one, fall back to any connected
  const channel = connectedChannels.find(
    (ch) => ch.isConnected() && (!p.channel || ch.name === p.channel),
  ) ?? connectedChannels.find((ch) => ch.isConnected());

  if (!channel) {
    json(res, 503, { error: 'No connected channel available' });
    return;
  }

  if (!channel.sendFile) {
    json(res, 501, { error: `Channel "${channel.name}" does not support sendFile` });
    return;
  }

  // Acknowledge immediately; delivery is async
  json(res, 200, { ok: true });

  channel.sendFile(p.chat_jid, p.ephemeral_url, p.filename, p.mime_type ?? 'application/octet-stream').catch(
    (err) => {
      logger.error({ err, artifact_id: p.artifact_id, chat_jid: p.chat_jid }, 'sendFile failed');
    },
  );
}

async function handleCronTick(_body: unknown, res: http.ServerResponse): Promise<void> {
  if (!_schedulerTick) {
    json(res, 503, { error: 'Scheduler not initialised' });
    return;
  }
  // Fire-and-forget: task execution is async and long-running.
  // Respond immediately so the cron service can exit cleanly.
  json(res, 200, { ok: true });
  _schedulerTick().catch((err) => {
    logger.error({ err }, 'cron-tick handler error');
  });
}

async function handleResetSession(body: unknown, res: http.ServerResponse): Promise<void> {
  const { groupFolder } = (body as { groupFolder?: string }) || {};
  const folder = groupFolder || 'webchat';

  // Clear session from DB
  deleteSession(folder);
  clearTaskContextCache();

  // Delete session directory on disk
  const sessionDir = path.join(GROUPS_DIR, '..', 'sessions', folder, '.claude');
  if (fs.existsSync(sessionDir)) {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ err, sessionDir }, 'Failed to delete session directory');
    }
  }

  // Clear in-memory session map
  _onSessionReset?.(folder);

  logger.info({ folder }, 'Session reset');
  json(res, 200, { ok: true });
}

async function handleSlackIncoming(body: unknown, res: http.ServerResponse): Promise<void> {
  const { event, team_id } = body as { event?: unknown; team_id?: string };
  if (!event) {
    json(res, 400, { error: 'Missing event' });
    return;
  }

  const slackChannel = connectedChannels.find(
    (ch) => ch.name === 'slack' && 'handleSlackEvent' in ch,
  ) as (Channel & { handleSlackEvent(e: unknown, t?: string): Promise<void> }) | undefined;

  if (!slackChannel) {
    json(res, 503, { error: 'Slack channel not connected' });
    return;
  }

  json(res, 200, { ok: true });

  slackChannel.handleSlackEvent(event, team_id).catch((err) => {
    logger.error({ err: err instanceof Error ? err.stack : err }, 'Slack handleSlackEvent failed');
  });
}

async function handleTelegramIncoming(body: unknown, res: http.ServerResponse): Promise<void> {
  const { update } = body as { update?: unknown };
  if (!update) {
    json(res, 400, { error: 'Missing update' });
    return;
  }

  const tgChannel = connectedChannels.find(
    (ch) => ch.name === 'telegram' && 'handleUpdate' in ch,
  ) as (Channel & { handleUpdate(u: unknown): Promise<void> }) | undefined;

  if (!tgChannel) {
    json(res, 503, { error: 'Telegram channel not connected' });
    return;
  }

  // Acknowledge immediately — processing is async (mirrors handleCronTick pattern)
  json(res, 200, { ok: true });

  tgChannel.handleUpdate(update).catch((err) => {
    logger.error({ err: err instanceof Error ? err.stack : err, update: JSON.stringify(update).slice(0, 200) }, 'Telegram handleUpdate failed');
  });
}

const ALLOWED_COMMANDS: Record<string, (body: unknown, res: http.ServerResponse) => Promise<void>> = {
  'refresh-pairing': handleRefreshPairing,
  'enable-integration': handleEnableIntegration,
  'disable-integration': handleDisableIntegration,
  'webhook-event': handleWebhookEvent,
  'allow-number': handleAllowNumber,
  'remove-number': handleRemoveNumber,
  'send-file': handleSendFile,
  'cron-tick': handleCronTick,
  'reset-session': handleResetSession,
  'telegram-incoming': handleTelegramIncoming,
  'slack-incoming': handleSlackIncoming,
};

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url || '';
  const method = req.method || '';

  // Health check — no auth required
  if (method === 'GET' && url === '/api/health') {
    return handleHealth(res);
  }

  // Command endpoints — require HMAC auth
  const commandMatch = url.match(/^\/api\/commands\/(.+)$/);
  if (method === 'POST' && commandMatch) {
    const command = commandMatch[1];
    const body = await readBody(req);
    const signature = req.headers['x-event-signature'] as string | undefined;

    if (!verifyHmac(body, signature)) {
      json(res, 401, { error: 'Invalid signature' });
      return;
    }

    const handler = ALLOWED_COMMANDS[command];
    if (!handler) {
      json(res, 400, { error: `Unknown command: ${command}` });
      return;
    }

    let parsed: unknown = {};
    try { parsed = JSON.parse(body); } catch {}
    return handler(parsed, res);
  }

  // Preview route — serve HTML/CSS/JS/images from preview directory (no auth)
  const previewMatch = url.match(/^\/preview\/(.+)$/);
  if (method === 'GET' && previewMatch) {
    const filename = decodeURIComponent(previewMatch[1]);
    if (filename.includes('..')) {
      return json(res, 400, { error: 'Invalid filename' });
    }
    // Serve from any group's preview dir — find the file
    const groupDirs = fs.existsSync(GROUPS_DIR) ? fs.readdirSync(GROUPS_DIR) : [];
    for (const group of groupDirs) {
      const filePath = path.join(GROUPS_DIR, group, 'preview', filename);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filename).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
          '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif',
          '.webp': 'image/webp', '.ico': 'image/x-icon',
        };
        res.writeHead(200, {
          'Content-Type': mimeTypes[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    }
    return json(res, 404, { error: 'Preview not found' });
  }

  json(res, 404, { error: 'Not found' });
}

export function startApiServer(port: number): void {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      logger.error({ err }, 'API server error');
      if (!res.writableEnded) {
        json(res, 500, { error: 'Internal server error' });
      }
    });
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'API server listening');
  });

  server.on('error', (err) => {
    logger.error({ err }, 'API server failed to start');
  });
}
