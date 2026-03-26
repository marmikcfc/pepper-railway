import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
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

    // Verify the actual HMAC value is correct by recomputing it from the request body
    const expectedSig = createHmac('sha256', EVENT_SECRET)
      .update(init?.body as string)
      .digest('hex');
    expect(headers['X-Event-Signature']).toBe(expectedSig);
  });

  it('sendMessage logs error and does not throw if Cloud returns error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'bad' }), { status: 400 }),
    );
    channel.currentTraceId = 'trace-abc';
    // Should not throw — errors are logged, not propagated
    await expect(channel.sendMessage('admin@nanoclaw', 'Hi')).resolves.toBeUndefined();
  });

  it('sendMessage does not throw when fetch network error occurs', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network failure'));
    channel.currentTraceId = 'trace-abc';
    // Should not throw — network errors are caught and logged
    await expect(channel.sendMessage('admin@nanoclaw', 'Hi')).resolves.toBeUndefined();
  });
});

describe('WebchatChannel self-registration', () => {
  it('registers under "webchat" key', async () => {
    // Import registry functions to verify the module has registered itself
    const { getChannelFactory, getRegisteredChannelNames } = await import(
      '../../../src/channels/registry.js'
    );

    // Verify 'webchat' is in the registered channel names
    const registeredNames = getRegisteredChannelNames();
    expect(registeredNames).toContain('webchat');

    // Verify getChannelFactory returns a factory for 'webchat'
    const factory = getChannelFactory('webchat');
    expect(factory).toBeDefined();

    // Verify the factory creates a WebchatChannel instance
    const instance = factory!({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: vi.fn().mockReturnValue({}),
    });
    expect(instance).toBeInstanceOf(WebchatChannel);
  });
});
