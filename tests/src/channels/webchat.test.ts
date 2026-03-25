import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebchatChannel } from '../../../src/channels/webchat.js';

const CLOUD_URL = 'https://cloud.example.com';
const TENANT_ID = 'tenant-uuid-123';
const EVENT_SECRET = 'test-secret';

describe('WebchatChannel', () => {
  let channel: WebchatChannel;

  beforeEach(() => {
    vi.stubEnv('NANOCLAW_CLOUD_URL', CLOUD_URL);
    vi.stubEnv('TENANT_ID', TENANT_ID);
    vi.stubEnv('NANOCLAW_EVENT_SECRET', EVENT_SECRET);
    channel = new WebchatChannel();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('ownsJid returns true only for admin@nanoclaw', () => {
    expect(channel.ownsJid('admin@nanoclaw')).toBe(true);
    expect(channel.ownsJid('other@nanoclaw')).toBe(false);
    expect(channel.ownsJid('group@g.us')).toBe(false);
  });

  it('isConnected always returns true', () => {
    expect(channel.isConnected()).toBe(true);
  });

  it('connect and disconnect are no-ops', async () => {
    await expect(channel.connect()).resolves.toBeUndefined();
    await expect(channel.disconnect()).resolves.toBeUndefined();
  });

  it('sendMessage POSTs webchat_agent_message to Cloud events API', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ accepted: 1 }), { status: 200 }),
    );

    channel.currentTraceId = 'trace-abc-123';
    await channel.sendMessage('admin@nanoclaw', 'Hello from agent');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${CLOUD_URL}/api/events/${TENANT_ID}`);
    expect(init?.method).toBe('POST');

    const body = JSON.parse(init?.body as string);
    expect(body.events).toHaveLength(1);
    const event = body.events[0];
    expect(event.event_type).toBe('webchat_agent_message');
    expect(event.channel).toBe('webchat');
    expect(event.trace_id).toBe('trace-abc-123');
    expect(event.data.content).toBe('Hello from agent');
    expect(event.status).toBe('complete');
  });

  it('sendMessage includes valid HMAC signature header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ accepted: 1 }), { status: 200 }),
    );

    channel.currentTraceId = 'trace-abc-123';
    await channel.sendMessage('admin@nanoclaw', 'Hello');

    const [, init] = fetchSpy.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Event-Signature']).toBeDefined();
    expect(typeof headers['X-Event-Signature']).toBe('string');
    expect(headers['X-Event-Signature']).toHaveLength(64); // hex HMAC-SHA256
  });

  it('sendMessage logs error and does not throw if Cloud returns error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'bad' }), { status: 400 }),
    );
    channel.currentTraceId = 'trace-abc';
    // Should not throw — errors are logged, not propagated
    await expect(channel.sendMessage('admin@nanoclaw', 'Hi')).resolves.toBeUndefined();
  });
});
