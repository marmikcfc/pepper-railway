import { createHmac, randomUUID } from 'crypto';
import { Channel } from '../types.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';

const WEBCHAT_JID = 'admin@nanoclaw';

export class WebchatChannel implements Channel {
  readonly name = 'webchat';
  /**
   * Set by api-server immediately before enqueueing — consumed (shifted) by
   * processGroupMessages at the start of each run. Kept separate from
   * currentTraceId so that a new incoming webhook cannot overwrite the trace
   * that is mid-flight in processGroupMessages.
   */
  incomingTraceId: string | null = null;
  /**
   * Set by processGroupMessages just before calling sendMessage; read
   * synchronously by sendMessage before its first await so no webhook
   * can interleave between the set and the read.
   */
  currentTraceId: string | null = null;

  ownsJid(jid: string): boolean {
    return jid === WEBCHAT_JID;
  }

  isConnected(): boolean {
    return true;
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}

  async sendMessage(_jid: string, text: string): Promise<void> {
    const cloudUrl = process.env.NANOCLAW_CLOUD_URL;
    const tenantId = process.env.TENANT_ID;
    const secret = process.env.NANOCLAW_EVENT_SECRET;

    if (!cloudUrl || !tenantId || !secret) {
      logger.error('WebchatChannel: missing env vars (NANOCLAW_CLOUD_URL, TENANT_ID, NANOCLAW_EVENT_SECRET)');
      return;
    }

    const event = {
      id: randomUUID(),
      tenant_id: tenantId,
      trace_id: this.currentTraceId ?? randomUUID(),
      parent_event_id: null,
      seq: 1,
      event_type: 'webchat_agent_message',
      status: 'complete',
      agent_name: 'agent',
      channel: 'webchat',
      data: { content: text },
      tokens_used: null,
      cost_usd: null,
      duration_ms: null,
      client_ts: new Date().toISOString(),
    };

    const body = JSON.stringify({ events: [event] });
    const signature = createHmac('sha256', secret).update(body).digest('hex');

    try {
      const res = await fetch(`${cloudUrl}/api/events/${tenantId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Event-Signature': signature,
        },
        body,
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        logger.error({ status: res.status, body: text }, 'WebchatChannel: failed to POST agent reply');
      }
    } catch (err) {
      logger.error({ err }, 'WebchatChannel: network error posting agent reply');
    }
  }
}

// Self-register. WebchatChannel needs no external credentials — it's always available.
// The factory accepts ChannelOpts even though WebchatChannel doesn't use them,
// because ChannelFactory type requires it.
registerChannel('webchat', (_opts: ChannelOpts) => new WebchatChannel());
