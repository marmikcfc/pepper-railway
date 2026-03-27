/**
 * Railway cron entrypoint — runs every minute as a separate Railway service.
 *
 * Posts an HMAC-signed request to the main nanoclaw service to trigger
 * scheduled task processing. Exits immediately after — Railway handles
 * the schedule.
 *
 * Required env vars:
 *   NANOCLAW_INTERNAL_URL   — e.g. http://nanoclaw.railway.internal:3000
 *   NANOCLAW_EVENT_SECRET   — shared HMAC secret (same as main service)
 */
import { createHmac } from 'crypto';

const url = process.env.NANOCLAW_INTERNAL_URL;
const secret = process.env.NANOCLAW_EVENT_SECRET;

if (!url) {
  console.error('NANOCLAW_INTERNAL_URL is not set');
  process.exit(1);
}

if (!secret) {
  console.error('NANOCLAW_EVENT_SECRET is not set');
  process.exit(1);
}

const body = '{}';
const signature = createHmac('sha256', secret).update(body).digest('hex');

try {
  const res = await fetch(`${url}/api/commands/cron-tick`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-event-signature': signature,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`cron-tick failed: ${res.status} ${text}`);
    process.exit(1);
  }

  console.log('cron-tick: ok');
  process.exit(0);
} catch (err) {
  console.error('cron-tick: fetch failed', err);
  process.exit(1);
}
