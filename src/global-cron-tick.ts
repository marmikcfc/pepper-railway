/**
 * Global Railway cron entrypoint — one service shared across all tenants.
 * Fires every minute, triggers the Vercel fan-out endpoint which queries
 * Supabase and pings only tenants with tasks due right now.
 *
 * Required env vars:
 *   NANOCLAW_CLOUD_URL  — e.g. https://nanoclaw.cloud
 *   CRON_SECRET         — shared secret, same value as set on Vercel
 */

const cloudUrl = process.env.NANOCLAW_CLOUD_URL;
const cronSecret = process.env.CRON_SECRET;

if (!cloudUrl) {
  console.error('NANOCLAW_CLOUD_URL is not set');
  process.exit(1);
}

if (!cronSecret) {
  console.error('CRON_SECRET is not set');
  process.exit(1);
}

try {
  const res = await fetch(`${cloudUrl}/api/cron/tick`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${cronSecret}`,
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`global-cron-tick failed: ${res.status} ${text}`);
    process.exit(1);
  }

  const data = await res.json();
  console.log(`global-cron-tick: ok — pinged=${data.pinged} errors=${data.errors} total=${data.total}`);
  process.exit(0);
} catch (err) {
  console.error('global-cron-tick: fetch failed', err);
  process.exit(1);
}
