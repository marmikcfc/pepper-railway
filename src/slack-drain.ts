import { createHmac } from 'crypto';
import { logger } from './logger.js';

interface PendingMessage {
  id: string;
  channel_id: string;
  event_payload: unknown;
}

export async function drainPendingSlackMessages(
  handleEvent: (event: unknown, teamId?: string) => Promise<void>,
): Promise<void> {
  const cloudUrl = process.env.PEPPER_CLOUD_URL;
  const agentId = process.env.AGENT_ID;
  const secret = process.env.PEPPER_EVENT_SECRET;
  if (!cloudUrl || !agentId || !secret) return;

  const signature = createHmac('sha256', secret).update(agentId).digest('hex');

  try {
    const res = await fetch(`${cloudUrl}/api/slack/pending/${agentId}`, {
      headers: { 'x-event-signature': signature },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, 'slack-drain: fetch returned non-200');
      return;
    }

    const { messages } = (await res.json()) as { messages: PendingMessage[] };
    if (!messages || messages.length === 0) return;

    logger.info({ count: messages.length }, 'slack-drain: processing pending messages');

    for (const msg of messages) {
      try {
        await handleEvent(msg.event_payload);
      } catch (err: any) {
        logger.warn({ err, messageId: msg.id }, 'slack-drain: failed to process message');
      }
    }

    logger.info({ count: messages.length }, 'slack-drain: done');
  } catch (err) {
    logger.warn({ err }, 'slack-drain: request failed (non-fatal)');
  }
}
