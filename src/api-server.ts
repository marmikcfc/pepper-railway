import http from 'http';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';

import { logger } from './logger.js';
import { downloadBuffer, processImage, processPdf } from './media.js';
import { Channel } from './types.js';
import { storeMessage, getAllRegisteredGroups } from './db.js';
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

export function setSchedulerTickFn(fn: () => Promise<void>): void {
  _schedulerTick = fn;
}

let connectedChannels: Channel[] = [];
const startTime = Date.now();

export function setChannels(channels: Channel[]): void {
  connectedChannels = channels;
}

function verifyHmac(body: string, signatureHeader: string | undefined): boolean {
  const secret = process.env.NANOCLAW_EVENT_SECRET;
  if (!secret) {
    logger.warn('NANOCLAW_EVENT_SECRET not set — rejecting command request');
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

  // Webchat path: bypass groupEntries lookup, store directly to admin@nanoclaw
  if (integrationId === 'webchat') {
    const { content, traceId, attachments: rawAttachments } = (payload as {
      content?: string;
      traceId: string;
      attachments?: { url: string; mimeType: string; filename?: string }[];
    });

    // Download and process any attachments (images/PDFs)
    const processedAttachments: import('./media.js').ProcessedAttachment[] = [];
    for (const att of rawAttachments ?? []) {
      try {
        const buffer = await downloadBuffer(att.url);
        const processed = att.mimeType === 'application/pdf'
          ? processPdf(buffer, att.filename)
          : await processImage(buffer, att.mimeType, att.filename);
        processedAttachments.push(processed);
      } catch (err) {
        logger.warn({ err, url: att.url }, 'Failed to process webchat attachment');
      }
    }

    const messageContent = content || processedAttachments.map((a) =>
      a.type === 'image' ? '[Image]' : '[PDF]'
    ).join(' ') || '';

    storeMessage({
      id: randomUUID(),
      chat_jid: 'admin@nanoclaw',
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
    const channel = _getWebchatChannel?.();
    if (channel) {
      channel.incomingTraceIds.push(traceId);
    }

    _enqueueWebchat?.('admin@nanoclaw');
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

const ALLOWED_COMMANDS: Record<string, (body: unknown, res: http.ServerResponse) => Promise<void>> = {
  'refresh-pairing': handleRefreshPairing,
  'enable-integration': handleEnableIntegration,
  'disable-integration': handleDisableIntegration,
  'webhook-event': handleWebhookEvent,
  'allow-number': handleAllowNumber,
  'remove-number': handleRemoveNumber,
  'send-file': handleSendFile,
  'cron-tick': handleCronTick,
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
