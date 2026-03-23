/**
 * Infer whether a JID represents a direct message (DM) based on its format.
 * Used as a fallback when the `is_group` DB column is not yet available.
 *
 * - WhatsApp DM: *@s.whatsapp.net
 * - Telegram DM: tg:<positive_number>
 * - Slack DM: slack:D*
 * - Discord: cannot infer from JID (defaults to group)
 * - All other formats: group
 */
export function inferIsDM(jid: string): boolean {
  if (jid.endsWith('@s.whatsapp.net')) return true;
  if (jid.startsWith('tg:') && !jid.startsWith('tg:-')) return true;
  if (jid.startsWith('slack:D')) return true;
  return false;
}
