import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

/**
 * Format thread messages with recent channel activity as background context.
 * The agent gets full thread conversation + awareness of recent channel messages.
 */
export function formatThreadWithContext(
  threadMessages: NewMessage[],
  recentChannelMessages: NewMessage[],
  timezone?: string,
): string {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Filter out messages already in the thread to avoid duplicates
  const threadIds = new Set(threadMessages.map((m) => m.id));
  const contextOnly = recentChannelMessages.filter((m) => !threadIds.has(m.id));

  let result = '';
  if (contextOnly.length > 0) {
    const contextLines = contextOnly.map((m) => {
      const displayTime = formatLocalTime(m.timestamp, tz);
      return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
    });
    result += `<channel-context note="Recent channel activity for background awareness">\n${contextLines.join('\n')}\n</channel-context>\n`;
  }
  result += formatMessages(threadMessages, tz);
  return result;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
