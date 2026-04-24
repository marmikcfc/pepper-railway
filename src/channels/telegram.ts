import { Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { downloadBuffer, processAttachment, processImage, processPdf } from '../media.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { hasSeenUpdate, markSeenUpdate } from '../telegram-idempotency.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  // Track active thread per chat: chatId → message_id to reply to
  private activeThread = new Map<string, number>();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Determine thread context.
      // Use message_thread_id for forum topics, or the message_id for
      // regular chats (bot will reply to this message to form a chain).
      const forumThreadId = ctx.message.message_thread_id;
      const threadId = forumThreadId
        ? String(forumThreadId)
        : String(ctx.message.message_id);

      // Track so sendMessage can reply to this message
      this.activeThread.set(String(ctx.chat.id), ctx.message.message_id);

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      logger.info({ chatJid, chatName, sender: senderName, contentLen: content.length }, '[tg-channel] calling onMessage');
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        '[tg-channel] Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent.
    // Pass optional ProcessedAttachment[] for media types we can process.
    const storeNonText = (ctx: any, placeholder: string, attachments?: import('../media.js').ProcessedAttachment[]) => {
      const chatJid = `tg:${ctx.chat.id}`;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
        attachments,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const token = process.env.TELEGRAM_BOT_TOKEN!;
      try {
        // getFile returns the highest-res photo (last in array)
        const photos = ctx.message.photo!;
        const fileId = photos[photos.length - 1].file_id;
        const file = await ctx.api.getFile(fileId);
        const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        const buffer = await downloadBuffer(url);
        const att = await processImage(buffer, 'image/jpeg');
        const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
        storeNonText(ctx, `[Image]${caption}`, [att]);
      } catch (err) {
        logger.warn({ err }, 'Telegram: failed to process photo, using placeholder');
        storeNonText(ctx, '[Photo]');
      }
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', async (ctx) => {
        try {
          const doc = ctx.message.document;
          const name = doc.file_name || 'document';
          const mime = doc.mime_type || 'application/octet-stream';

          // Skip video/audio MIME types
          if (mime.startsWith('video/') || mime.startsWith('audio/')) {
            storeNonText(ctx, `[Document: ${name}]`);
            return;
          }

          const token = process.env.TELEGRAM_BOT_TOKEN!;
          const file = await ctx.api.getFile(doc.file_id);
          const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
          const buffer = await downloadBuffer(url);

          // Process the attachment (image/PDF get multimodal blocks, others get file type)
          const att = await processAttachment(buffer, mime, name);
          if (att) {
            const placeholder = att.type === 'image' ? '[Image]'
              : att.type === 'document' ? `[PDF: ${name}]`
              : `[File: ${name}]`;
            storeNonText(ctx, placeholder, [att]);
          } else {
            storeNonText(ctx, `[Document: ${name}]`);
          }

          // Upload to Supabase drive (fire-and-forget)
          this.uploadToCloud(buffer, name, mime).catch((err: unknown) => {
            logger.warn({ err, filename: name }, 'Failed to upload Telegram document to cloud');
          });
        } catch (err) {
          logger.warn({ err }, 'Failed to process Telegram document');
          storeNonText(ctx, `[Document: ${ctx.message.document.file_name || 'document'}]`);
        }
      });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Webhook mode: initialize bot (registers middleware pipeline) then validate token
    await this.bot.init();
    logger.info({ username: this.bot.botInfo.username, id: this.bot.botInfo.id }, 'Telegram bot ready (webhook mode)');
    console.log(`\n  Telegram bot: @${this.bot.botInfo.username}`);
    console.log(`  Receiving messages via Vercel gateway — no local polling\n`);
  }

  /**
   * Process a single Telegram Update received from the gateway.
   * Called by the api-server's `telegram-incoming` command handler.
   */
  async handleUpdate(update: unknown): Promise<void> {
    if (!this.bot) {
      logger.error('[tg-channel] handleUpdate called but bot is null — not initialized');
      return;
    }
    const upd = update as {
      update_id?: number;
      message?: { chat?: { id: number }; text?: string };
    };
    const agentId = process.env.AGENT_ID;
    const updateId = typeof upd.update_id === 'number' ? upd.update_id : undefined;
    if (agentId && updateId !== undefined && hasSeenUpdate(agentId, updateId)) {
      logger.info({ update_id: updateId }, '[tg-channel] skip duplicate update');
      return;
    }
    logger.info({ chatId: upd.message?.chat?.id, text: upd.message?.text?.slice(0, 60), update_id: updateId }, '[tg-channel] dispatching to grammY');
    try {
      await this.bot.handleUpdate(update as Parameters<typeof this.bot.handleUpdate>[0]);
      if (agentId && updateId !== undefined) markSeenUpdate(agentId, updateId);
      logger.info('[tg-channel] grammY handleUpdate completed');
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.stack : err }, '[tg-channel] grammY handleUpdate THREW');
      throw err;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const replyTo = this.activeThread.get(numericId);

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      const replyParams = replyTo
        ? { reply_parameters: { message_id: replyTo } }
        : {};
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text, replyParams);
      } else {
        // Only reply to the first chunk; subsequent chunks are standalone
        await this.bot.api.sendMessage(
          numericId,
          text.slice(0, MAX_LENGTH),
          replyParams,
        );
        for (let i = MAX_LENGTH; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info(
        { jid, length: text.length, replyTo },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendFile(jid: string, url: string, filename: string, mimeType: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!resp.ok) throw new Error(`Failed to fetch file: ${resp.status}`);
      const buffer = Buffer.from(await resp.arrayBuffer());

      const { InputFile } = await import('grammy');
      await this.bot.api.sendDocument(
        numericId,
        new InputFile(buffer, filename),
        { caption: filename },
      );
      logger.info({ jid, filename }, 'Telegram file sent');
    } catch (err) {
      logger.error({ jid, filename, err }, 'Failed to send Telegram file');
    }
  }

  private async uploadToCloud(buffer: Buffer, filename: string, mimeType: string): Promise<void> {
    const cloudUrl = process.env.PEPPER_CLOUD_URL;
    const agentId = process.env.AGENT_ID;
    const secret = process.env.PEPPER_EVENT_SECRET;
    if (!cloudUrl || !agentId || !secret) return;

    const body = JSON.stringify({
      filename,
      mimeType,
      sizeBytes: buffer.length,
      source: 'telegram',
      data: buffer.toString('base64'),
    });

    const { createHmac } = await import('crypto');
    const signature = createHmac('sha256', secret).update(body).digest('hex');

    await fetch(`${cloudUrl}/api/artifacts/${agentId}/upload-external`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Event-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
