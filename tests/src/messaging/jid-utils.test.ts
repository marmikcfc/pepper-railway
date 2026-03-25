import { describe, it, expect } from 'vitest';
import { inferIsDM } from '../../../src/jid-utils.js';

describe('inferIsDM', () => {
  // WhatsApp
  it('WhatsApp DM (@s.whatsapp.net)', () => {
    expect(inferIsDM('919654160898@s.whatsapp.net')).toBe(true);
  });
  it('WhatsApp group (@g.us)', () => {
    expect(inferIsDM('120363419800210527@g.us')).toBe(false);
  });

  // Telegram
  it('Telegram DM (positive ID)', () => {
    expect(inferIsDM('tg:1051854280')).toBe(true);
  });
  it('Telegram group (negative ID)', () => {
    expect(inferIsDM('tg:-1001234567890')).toBe(false);
  });

  // Slack
  it('Slack DM (D prefix)', () => {
    expect(inferIsDM('slack:D0123456789')).toBe(true);
  });
  it('Slack channel (C prefix)', () => {
    expect(inferIsDM('slack:C0123456789')).toBe(false);
  });
  it('Slack group (G prefix)', () => {
    expect(inferIsDM('slack:G0123456789')).toBe(false);
  });

  // Discord — cannot infer from JID, defaults to group
  it('Discord channel defaults to group', () => {
    expect(inferIsDM('dc:123456789')).toBe(false);
  });

  // Edge cases
  it('unknown JID format defaults to group', () => {
    expect(inferIsDM('gmail:thread123')).toBe(false);
  });
  it('__group_sync__ sentinel is not a DM', () => {
    expect(inferIsDM('__group_sync__')).toBe(false);
  });
});
