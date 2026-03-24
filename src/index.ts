import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  IS_RAILWAY,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getThreadMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  formatThreadWithContext,
} from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { syncMcpOnStartup } from './mcp-installer.js';
import { syncSkillsOnStartup } from './skill-installer.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { inferIsDM } from './jid-utils.js';
import { logger } from './logger.js';
import { setAllowedNumberFns, setChannels, startApiServer } from './api-server.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let allowedWhatsAppNumbers: Set<string> = new Set();

async function fetchAllowedNumbers(): Promise<void> {
  const cloudUrl = process.env.NANOCLAW_CLOUD_URL;
  const tenantId = process.env.TENANT_ID;
  const secret = process.env.NANOCLAW_EVENT_SECRET;
  if (!cloudUrl || !tenantId || !secret) return;

  const signature = crypto
    .createHmac('sha256', secret)
    .update(tenantId)
    .digest('hex');

  try {
    const res = await fetch(`${cloudUrl}/api/provision/${tenantId}/allowed-numbers`, {
      headers: { 'x-signature': signature },
    });
    if (res.ok) {
      const data = await res.json() as { numbers?: string[] };
      allowedWhatsAppNumbers = new Set(data.numbers || []);
      logger.info({ count: allowedWhatsAppNumbers.size }, 'Loaded allowed WhatsApp numbers');
    } else {
      logger.warn({ status: res.status }, 'Failed to fetch allowed numbers, retrying in 30s');
      setTimeout(fetchAllowedNumbers, 30000);
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch allowed numbers, retrying in 30s');
    setTimeout(fetchAllowedNumbers, 30000);
  }
}

export function addAllowedWhatsAppNumber(phone: string): void {
  allowedWhatsAppNumbers.add(phone);
}

export function removeAllowedWhatsAppNumber(phone: string): void {
  allowedWhatsAppNumbers.delete(phone);
}

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__')
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isDM = group.isDM === true;

  // WhatsApp personal number mode: check whitelist for DMs
  if (isDM && !ASSISTANT_HAS_OWN_NUMBER && chatJid.endsWith('@s.whatsapp.net')) {
    const phone = chatJid.replace('@s.whatsapp.net', '');
    const ownPhone = channel?.getConnectedPhone?.();
    if (phone !== ownPhone && !allowedWhatsAppNumbers.has(phone)) {
      return true; // Skip — not in whitelist
    }
  }

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-DM chats, check if trigger is required and present
  if (!isDM && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // If the latest message has a thread_id, use full thread as context
  // plus recent channel activity for background awareness
  const latestMsg = missedMessages[missedMessages.length - 1];
  let prompt: string;
  if (latestMsg.thread_id) {
    const threadMsgs = getThreadMessages(chatJid, latestMsg.thread_id);
    const recent = getMessagesSince(
      chatJid,
      sinceTimestamp,
      ASSISTANT_NAME,
    ).slice(-5);
    prompt = formatThreadWithContext(threadMsgs, recent);
  } else {
    prompt = formatMessages(missedMessages, TIMEZONE);
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = false; // All admin operations moved to dashboard
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isDM = group.isDM === true;

          // WhatsApp personal number mode: check whitelist for DMs
          if (isDM && !ASSISTANT_HAS_OWN_NUMBER && chatJid.endsWith('@s.whatsapp.net')) {
            const phone = chatJid.replace('@s.whatsapp.net', '');
            const ownPhone = channel?.getConnectedPhone?.();
            if (phone !== ownPhone && !allowedWhatsAppNumbers.has(phone)) {
              continue; // Skip — not in whitelist
            }
          }

          const needsTrigger = !isDM && group.requiresTrigger !== false;

          // For non-DM chats, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Build context: if the latest message has a thread_id, use the
          // full thread + recent channel activity. Otherwise fall back to
          // all messages since last agent run.
          const latestMsg = groupMessages[groupMessages.length - 1];
          let messagesToSend: NewMessage[];
          let formatted: string;
          if (latestMsg.thread_id) {
            const threadMsgs = getThreadMessages(chatJid, latestMsg.thread_id);
            const recent = getMessagesSince(
              chatJid,
              lastAgentTimestamp[chatJid] || '',
              ASSISTANT_NAME,
            ).slice(-5);
            messagesToSend = threadMsgs;
            formatted = formatThreadWithContext(threadMsgs, recent);
          } else {
            const allPending = getMessagesSince(
              chatJid,
              lastAgentTimestamp[chatJid] || '',
              ASSISTANT_NAME,
            );
            messagesToSend = allPending.length > 0 ? allPending : groupMessages;
            formatted = formatMessages(messagesToSend, TIMEZONE);
          }

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  // On Railway, remove stale /data/.env if it exists.
  // Secrets now come from Railway service config (process.env).
  // The old .env may contain secrets written by the removed set_env_var tool.
  if (IS_RAILWAY) {
    const staleEnvPath = path.join(
      process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data',
      '.env',
    );
    if (fs.existsSync(staleEnvPath)) {
      fs.unlinkSync(staleEnvPath);
      logger.info(
        'Removed stale /data/.env — secrets now come from Railway service config',
      );
    }
  }

  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Sync skills from lock file (re-clones registered repos so skills
  // survive deploys and stay up-to-date with their source repos)
  await syncSkillsOnStartup();

  // Sync persistent MCP servers (rebuild .mcp.json from lock file)
  await syncMcpOnStartup();

  // Start credential proxy (containers route API calls through this)
  // On Railway, secrets are passed via stdin instead, so the proxy is a no-op guard.
  let proxyServer: { close: () => void } | undefined;
  if (!IS_RAILWAY) {
    proxyServer = await startCredentialProxy(
      CREDENTIAL_PROXY_PORT,
      PROXY_BIND_HOST,
    );
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer?.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    _command: string,
    chatJid: string,
    _msg: NewMessage,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    await channel.sendMessage(
      chatJid,
      'Remote control is managed from the dashboard.',
    );
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Auto-register unregistered chats on first message.
      // DMs don't require trigger, groups do.
      if (!registeredGroups[chatJid]) {
        let prefix: string | undefined;
        if (chatJid.startsWith('slack:')) prefix = 'slack';
        else if (chatJid.startsWith('tg:')) prefix = 'tg';
        else if (chatJid.startsWith('dc:')) prefix = 'dc';
        else if (
          chatJid.includes('@g.us') ||
          chatJid.includes('@s.whatsapp.net')
        )
          prefix = 'wa';

        if (prefix) {
          const chatName = msg.sender_name || chatJid;
          const safeName = chatName
            .replace(/[^a-zA-Z0-9-]/g, '-')
            .toLowerCase()
            .slice(0, 50);
          const chatIsDM = inferIsDM(chatJid);

          registerGroup(chatJid, {
            name: chatName,
            folder: `${prefix}_${safeName}`,
            trigger: `@${ASSISTANT_NAME}`,
            added_at: new Date().toISOString(),
            requiresTrigger: !chatIsDM,
            isDM: chatIsDM || undefined,
          });
          logger.info(
            { jid: chatJid, name: chatName, isDM: chatIsDM },
            'Auto-registered chat on first message',
          );
        }
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Start API server early so cloud commands (e.g. "Get New Code") work during initial pairing.
  // setChannels is called after channels connect — handlers tolerate an empty channel list.
  if (process.env.PORT) {
    startApiServer(Number(process.env.PORT));
  }
  setAllowedNumberFns(addAllowedWhatsAppNumber, removeAllowedWhatsAppNumber);

  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Set env vars in Railway service config (or .env locally).',
      );
      continue;
    }
    channels.push(channel);
    setChannels(channels);  // Update API server immediately so commands work during connect()
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Fetch allowed WhatsApp numbers from cloud (personal number mode whitelist)
  fetchAllowedNumbers().catch((err) =>
    logger.warn({ err }, 'Failed to fetch allowed WhatsApp numbers on startup'),
  );

  // Migrate existing 'main' folder to prefix_safename format
  {
    const mainGroup = Object.entries(registeredGroups).find(
      ([, g]) => g.folder === 'main',
    );
    if (mainGroup) {
      const [jid, group] = mainGroup;
      let prefix: string | undefined;
      if (jid.startsWith('slack:')) prefix = 'slack';
      else if (jid.startsWith('tg:')) prefix = 'tg';
      else if (jid.startsWith('dc:')) prefix = 'dc';
      else if (jid.includes('@g.us') || jid.includes('@s.whatsapp.net')) prefix = 'wa';

      if (prefix) {
        const safeName = (group.name || jid)
          .replace(/[^a-zA-Z0-9-]/g, '-')
          .toLowerCase()
          .slice(0, 50);
        const newFolder = `${prefix}_${safeName}`;
        const oldPath = path.join(GROUPS_DIR, 'main');
        const newPath = path.join(GROUPS_DIR, newFolder);

        if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
          fs.renameSync(oldPath, newPath);
          logger.info({ oldFolder: 'main', newFolder }, 'Migrated main folder');
        }

        // Re-register with new folder name and isDM
        const chatIsDM = inferIsDM(jid);
        registerGroup(jid, {
          ...group,
          folder: newFolder,
          isDM: chatIsDM || undefined,
          requiresTrigger: !chatIsDM,
        });
        delete (registeredGroups[jid] as any).isMain;
        logger.info({ jid, newFolder, isDM: chatIsDM }, 'Migrated main group registration');
      }
    }
  }

  // Auto-register any chats (groups or DMs) the bot is a member of that
  // aren't already registered. Runs on every startup so newly-added
  // channels (Slack, Telegram, Discord, WhatsApp) are picked up automatically.
  {
    await Promise.all(
      channels.filter((ch) => ch.syncGroups).map((ch) => ch.syncGroups!(false)),
    );
    const allChats = getAllChats();
    for (const chat of allChats) {
      if (!registeredGroups[chat.jid] && chat.name) {
        let prefix: string;
        if (chat.jid.startsWith('slack:')) prefix = 'slack';
        else if (chat.jid.startsWith('tg:')) prefix = 'tg';
        else if (chat.jid.startsWith('dc:')) prefix = 'dc';
        else if (
          chat.jid.includes('@g.us') ||
          chat.jid.includes('@s.whatsapp.net')
        )
          prefix = 'wa';
        else continue; // skip unknown JID formats (gmail, etc.)

        const safeName = chat.name
          .replace(/[^a-zA-Z0-9-]/g, '-')
          .toLowerCase()
          .slice(0, 50);
        const folderName = `${prefix}_${safeName}`;
        const chatIsDM = chat.is_group === 0 || ((chat.is_group as number | null) === null && inferIsDM(chat.jid));
        registerGroup(chat.jid, {
          name: chat.name,
          folder: folderName,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: !chatIsDM,
          isDM: chatIsDM || undefined,
        });
        logger.info(
          { jid: chat.jid, name: chat.name, folder: folderName, isDM: chatIsDM },
          'Auto-registered chat',
        );
      }
    }
  }

  // Final setChannels ensures the API server sees all connected channels
  setChannels(channels);

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
