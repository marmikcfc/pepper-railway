import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

const MAX_MESSAGE_LENGTH = 4000;

interface SlackEvent {
  type: string;
  channel: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private botToken: string;
  private botUserId: string | undefined;
  private connected = false;
  private userNameCache = new Map<string, string>();
  private activeThread = new Map<string, string>();
  private opts: {
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    registeredGroups: () => Record<string, RegisteredGroup>;
  };

  constructor(
    botToken: string,
    opts: {
      onMessage: OnInboundMessage;
      onChatMetadata: OnChatMetadata;
      registeredGroups: () => Record<string, RegisteredGroup>;
    },
  ) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    try {
      const res = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${this.botToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as { ok: boolean; user_id?: string };
      if (data.ok && data.user_id) {
        this.botUserId = data.user_id;
        logger.info({ botUserId: this.botUserId }, 'Slack bot identity resolved');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to resolve Slack bot identity');
    }

    this.connected = true;
    logger.info('Slack channel connected (HTTP relay mode)');

    await this.syncGroups();
  }

  async handleSlackEvent(event: SlackEvent, teamId?: string): Promise<void> {
    if (!event.text) return;

    const jid = `slack:${event.channel}`;
    const timestamp = new Date(parseFloat(event.ts) * 1000).toISOString();
    const isGroup = event.channel_type !== 'im';

    this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

    const groups = this.opts.registeredGroups();
    if (!groups[jid]) return;

    const isBotMessage = !!event.bot_id || event.user === this.botUserId;

    let senderName: string;
    if (isBotMessage) {
      senderName = ASSISTANT_NAME;
    } else {
      senderName = (event.user ? await this.resolveUserName(event.user) : undefined)
        || event.user || 'unknown';
    }

    const threadId = event.thread_ts || event.ts;

    if (!isBotMessage) {
      this.activeThread.set(event.channel, threadId);
    }

    let content = event.text;
    if (this.botUserId && !isBotMessage) {
      const mentionPattern = `<@${this.botUserId}>`;
      if (content.includes(mentionPattern) && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    this.opts.onMessage(jid, {
      id: event.ts,
      chat_jid: jid,
      sender: event.user || event.bot_id || '',
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: isBotMessage,
      is_bot_message: isBotMessage,
      thread_id: threadId,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const threadTs = this.activeThread.get(channelId);

    try {
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.postMessage(channelId, text, threadTs);
      } else {
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.postMessage(channelId, text.slice(i, i + MAX_MESSAGE_LENGTH), threadTs);
        }
      }
      logger.info({ jid, length: text.length, threadTs }, 'Slack message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Slack message');
    }
  }

  private async postMessage(channel: string, text: string, threadTs?: string): Promise<void> {
    const payload: Record<string, string> = { channel, text };
    if (threadTs) payload.thread_ts = threadTs;

    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.botToken}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`Slack chat.postMessage failed: HTTP ${res.status}`);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {}

  async syncGroups(_force?: boolean): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;
      const now = new Date().toISOString();

      do {
        const res = await fetch(
          `https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200${cursor ? `&cursor=${cursor}` : ''}`,
          {
            headers: { Authorization: `Bearer ${this.botToken}` },
            signal: AbortSignal.timeout(10_000),
          },
        );
        const result = (await res.json()) as {
          channels?: Array<{ id: string; name: string; is_member: boolean }>;
          response_metadata?: { next_cursor?: string };
        };

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            const jid = `slack:${ch.id}`;
            updateChatName(jid, ch.name);
            this.opts.onChatMetadata(jid, now, ch.name, 'slack', true);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const res = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
        headers: { Authorization: `Bearer ${this.botToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as {
        ok: boolean;
        user?: { real_name?: string; name?: string };
      };
      const name = data.user?.real_name || data.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN']);
  const botToken = envVars.SLACK_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    logger.warn('Slack: SLACK_BOT_TOKEN not set — skipping');
    return null;
  }
  return new SlackChannel(botToken, opts);
});
