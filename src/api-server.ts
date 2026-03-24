import http from 'http';
import { createHmac, timingSafeEqual } from 'crypto';

import { logger } from './logger.js';
import { Channel } from './types.js';

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

const MAX_BODY_BYTES = 64 * 1024; // 64KB — generous for command payloads

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

const ALLOWED_COMMANDS: Record<string, (body: unknown, res: http.ServerResponse) => Promise<void>> = {
  'refresh-pairing': handleRefreshPairing,
  'allow-number': handleAllowNumber,
  'remove-number': handleRemoveNumber,
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
