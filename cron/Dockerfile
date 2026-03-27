# Global cron service — pings the Vercel fan-out endpoint every 5 minutes.
# Minimal Alpine + curl. ~10MB. No Node, no npm, no TypeScript.
FROM alpine:3.19
RUN apk add --no-cache curl
CMD ["sh", "-c", "curl -sf -H \"Authorization: Bearer ${CRON_SECRET}\" \"${NANOCLAW_CLOUD_URL}/api/cron/tick\" && echo 'cron-tick: ok' || { echo 'cron-tick: failed'; exit 1; }"]
