import pino from 'pino';

const IS_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT_NAME || !!process.env.RAILWAY_SERVICE_NAME;

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // On Railway: plain single-line JSON (Railway UI already formats it)
  // Locally: pino-pretty for human-readable output
  ...(IS_RAILWAY
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
