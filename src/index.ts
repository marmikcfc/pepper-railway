import { type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
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
  clearTaskContextCache,
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
import { getTaskContextIfNeeded } from './context-fetcher.js';
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
import { syncSkillsOnStartup, syncExternalSkills } from './skill-installer.js';
import { syncIntegrationsOnStartup } from './integrations/activator.js';
import { startSchedulerLoop, runDueTasks } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { inferIsDM } from './jid-utils.js';
import { logger } from './logger.js';
import { setAllowedNumberFns, setWebchatFns, setChannels, startApiServer, setSchedulerTickFn, setSessionResetFn, setKillProcessFn } from './api-server.js';
import type { WebchatChannel } from './channels/webchat.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
// Tracks the task_id of the currently running webchat agent so that messages
// for a different task are not IPC'd into the wrong agent context.
let runningWebchatTaskId: string | null = null;
// True once the running agent has sent its response (idle, waiting for IPC).
// Only safe to close stdin when idle — not mid-response.
let webchatAgentIdle = false;

let allowedWhatsAppNumbers: Set<string> = new Set();

async function fetchAllowedNumbers(): Promise<void> {
  const cloudUrl = process.env.PEPPER_CLOUD_URL;
  const agentId = process.env.AGENT_ID;
  const secret = process.env.PEPPER_EVENT_SECRET;
  if (!cloudUrl || !agentId || !secret) return;

  const signature = crypto
    .createHmac('sha256', secret)
    .update(agentId)
    .digest('hex');

  try {
    const res = await fetch(`${cloudUrl}/api/provision/${agentId}/allowed-numbers`, {
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

/**
 * Ensures the webchat admin channel (admin@pepper) is registered as a group.
 * Called after loadState() so we can check if it already exists.
 * admin@pepper never came from a real channel — it must be seeded explicitly.
 */
function bootstrapWebchatGroup(): void {
  if (registeredGroups['admin@pepper']) return; // Already registered (persists across restarts)

  const now = new Date().toISOString();
  storeChatMetadata('admin@pepper', now, 'Dashboard', 'webchat', false);
  registerGroup('admin@pepper', {
    name: 'Dashboard',
    folder: 'webchat',
    trigger: '',
    added_at: now,
    requiresTrigger: false,
    isDM: true,
  });
  logger.info('Bootstrapped admin@pepper webchat group');
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

  logger.debug(
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
    .filter((c) => c.jid !== '__group_sync__' && c.is_group === 1)
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

  // IPC guard: if a webchat agent is already running for a different task,
  // defer this message — don't IPC it into the wrong context. The message
  // stays in SQLite and gets picked up once the current agent finishes.
  if (channel.ownsJid('admin@pepper') && runningWebchatTaskId !== null) {
    const wc = channel as WebchatChannel;
    const incomingTaskId = wc.incomingTaskIds.at(-1) ?? null;
    if (incomingTaskId !== runningWebchatTaskId) {
      logger.info(
        { running: runningWebchatTaskId, incoming: incomingTaskId },
        'Webchat message deferred — different task context than running agent',
      );
      return true; // leave queues intact, message stays in SQLite
    }
  }

  // Drain incomingTraceIds for this run — use the latest (most recent message).
  // A queue prevents rapid messages from silently dropping earlier traceIds.
  // A new webhook arriving mid-run pushes to the queue and will be consumed by
  // the next call to processGroupMessages.
  const webchatTraceId = channel.ownsJid('admin@pepper')
    ? (() => {
        const wc = channel as WebchatChannel;
        const ids = wc.incomingTraceIds.splice(0); // drain atomically
        return ids.length > 0 ? ids[ids.length - 1] : null; // use most recent
      })()
    : null;

  const webchatTaskId = channel.ownsJid('admin@pepper')
    ? (() => {
        const wc = channel as WebchatChannel;
        const ids = wc.incomingTaskIds.splice(0);
        return ids.length > 0 ? ids[ids.length - 1] : null;
      })()
    : null;

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

  // Log incoming messages for observability
  logger.info(
    {
      group: group.name,
      isDM,
      messageCount: missedMessages.length,
    },
    'Incoming messages',
  );

  // For non-DM chats, check if trigger is required and present
  if (!isDM && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    logger.info(
      {
        group: group.name,
        hasTrigger,
      },
      hasTrigger ? 'Trigger found — invoking agent' : 'No trigger found — skipping agent',
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

  // Pull task context from cloud (only on first message per task_id)
  if (webchatTaskId) {
    const taskContext = await getTaskContextIfNeeded(webchatTaskId);
    if (taskContext) {
      prompt = `<context>${taskContext}</context>\n\n${prompt}`;
    }
  }

  // Collect attachments from all pending messages (first 5 to avoid huge payloads)
  const attachments = missedMessages
    .flatMap((m) => m.attachments ?? [])
    .slice(0, 5);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length, attachmentCount: attachments.length },
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

  if (channel.ownsJid('admin@pepper')) { runningWebchatTaskId = webchatTaskId; webchatAgentIdle = false; }
  const output = await runAgent(group, prompt, chatJid, attachments.length ? attachments : undefined, webchatTaskId, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info(
        {
          group: group.name,
          rawLength: raw.length,
          textLength: text.length,
          response: text.slice(0, 500),
        },
        'Agent response',
      );
      if (text) {
        // Always sync currentTraceId right before sendMessage — even when null.
        // Clearing it prevents a stale traceId from a previous run bleeding into
        // this one if webchatTraceId is null (e.g. no new messages this cycle).
        if (channel.ownsJid('admin@pepper')) {
          (channel as WebchatChannel).currentTraceId = webchatTraceId;
          (channel as WebchatChannel).currentTaskId = webchatTaskId;
        }
        await channel.sendMessage(chatJid, text);
        logger.info({ group: group.name, chatJid, textLength: text.length }, 'Response sent to user');
        outputSentToUser = true;
      } else {
        logger.warn({ group: group.name, rawLength: raw.length }, 'Agent response was empty after stripping <internal> blocks — nothing sent to user');
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
      if (channel.ownsJid('admin@pepper')) webchatAgentIdle = true;
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  if (channel.ownsJid('admin@pepper')) { runningWebchatTaskId = null; webchatAgentIdle = false; }
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
    // Notify the user so they aren't left hanging, then roll back the cursor.
    try {
      await channel.sendMessage(chatJid, "Something went wrong and I couldn't complete that. Please try again.");
    } catch (sendErr) {
      logger.warn({ group: group.name, err: sendErr }, 'Failed to send error notification to user');
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
  attachments?: import('./media.js').ProcessedAttachment[],
  taskId?: string | null,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
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

  // Update available groups snapshot
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          if (sessionId && output.newSessionId !== sessionId) {
            clearTaskContextCache();
          }
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
        attachments: attachments?.length ? attachments : undefined,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        assistantName: ASSISTANT_NAME,
        ...(taskId ? { taskId } : {}),
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      if (sessionId && output.newSessionId !== sessionId) {
        clearTaskContextCache();
      }
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

  logger.info(`Pepper running (trigger: @${ASSISTANT_NAME})`);

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

          // Write attachments from pending messages to disk so the running
          // agent can read them via the Read tool (IPC only sends text).
          const ipcAttachments = messagesToSend
            .flatMap((m) => m.attachments ?? [])
            .slice(0, 5);
          let attachmentSuffix = '';
          if (ipcAttachments.length > 0) {
            const attachDir = path.join(resolveGroupFolderPath(group.folder), 'attachments');
            fs.mkdirSync(attachDir, { recursive: true });
            const notes: string[] = [];
            for (const att of ipcAttachments) {
              try {
                const filename = att.filename || `attachment.${att.mimeType.split('/')[1] || 'bin'}`;
                fs.writeFileSync(path.join(attachDir, filename), Buffer.from(att.base64, 'base64'));
                notes.push(`[Attached: ./attachments/${filename}]`);
                logger.info({ filename, bytes: att.base64.length }, 'IPC: wrote attachment to disk');
              } catch (err) {
                logger.warn({ err, filename: att.filename }, 'IPC: failed to write attachment to disk');
              }
            }
            if (notes.length > 0) {
              attachmentSuffix = '\n\n' + notes.join('\n') + '\nUse the Read tool to view these files.';
            }
          }

          // IPC routing guard for webchat: the startMessageLoop pipes directly
          // to running agents via queue.sendMessage, bypassing processGroupMessages.
          // Guard it here — the real IPC path — to prevent messages from a
          // different task context from contaminating the running agent.
          if (chatJid === 'admin@pepper' && runningWebchatTaskId !== null) {
            const wc = channel as WebchatChannel;
            const incomingTaskId = wc.incomingTaskIds.at(-1) ?? null;
            if (incomingTaskId !== runningWebchatTaskId) {
              if (webchatAgentIdle) {
                // Agent already responded and is just idling — safe to close
                // so the deferred message is processed in seconds, not minutes.
                logger.info(
                  { running: runningWebchatTaskId, incoming: incomingTaskId },
                  'Webchat message deferred — closing idle agent to unblock',
                );
                queue.closeStdin(chatJid);
              } else {
                // Agent is mid-response — defer without interrupting it.
                // Message stays in SQLite and will be processed after this run finishes.
                logger.info(
                  { running: runningWebchatTaskId, incoming: incomingTaskId },
                  'Webchat message deferred — agent busy, will process after current run',
                );
              }
              continue; // leave cursor as-is; message stays in SQLite for next spawn
            }
          }

          if (queue.sendMessage(chatJid, formatted + attachmentSuffix)) {
            logger.debug(
              { chatJid, count: messagesToSend.length, attachmentCount: ipcAttachments.length },
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
  const recovering: string[] = [];
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      recovering.push(group.name);
      queue.enqueueMessageCheck(chatJid);
    }
  }
  if (recovering.length > 0) {
    logger.info({ count: recovering.length, groups: recovering }, 'Recovery: queued groups with unprocessed messages');
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

  // PEPPER_MODE: platform compute service — skip all channel/agent infrastructure
  if (process.env.PEPPER_MODE === 'true') {
    logger.info('Starting in PEPPER_MODE — platform compute service');
    if (process.env.PORT) {
      startApiServer(Number(process.env.PORT));
    } else {
      startApiServer(3000);
    }
    logger.info('Pepper Railway compute service ready');
    return; // Do not proceed with channel/agent startup
  }

  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  bootstrapWebchatGroup(); // Ensure admin@pepper webchat group exists
  restoreRemoteControl();

  // Sync skills from lock file (re-clones registered repos so skills
  // survive deploys and stay up-to-date with their source repos)
  await syncSkillsOnStartup();

  // Sync external skills from EXTERNAL_SKILLS env var (skills.sh marketplace)
  await syncExternalSkills();

  // Sync persistent MCP servers (rebuild .mcp.json from lock file)
  await syncMcpOnStartup();

  // Sync active integrations (register MCP servers from integrations.json)
  syncIntegrationsOnStartup();

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

    // Notify cloud FIRST so Supabase status flips to 'sleeping' before we
    // start refusing HTTP connections. Any in-flight webhook hits while we're
    // draining will see status=sleeping, skip the forward, and land in the
    // durable inbox instead of hitting a closing HTTP server.
    const _cloudUrl = process.env.PEPPER_CLOUD_URL;
    const _agentId = process.env.AGENT_ID;
    const _secret = process.env.PEPPER_EVENT_SECRET;
    if (IS_RAILWAY && _cloudUrl && _agentId && _secret) {
      try {
        const sleepBody = JSON.stringify({ sleeping: true });
        const sig = crypto.createHmac('sha256', _secret).update(sleepBody).digest('hex');
        await fetch(`${_cloudUrl}/api/agents/${_agentId}/sleep`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-event-signature': sig },
          body: sleepBody,
          signal: AbortSignal.timeout(5_000),
        });
        logger.info('Notified cloud: agent sleeping');
      } catch (err) {
        logger.warn({ err }, 'Failed to notify cloud of sleep');
      }
    }

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
          logger.debug(
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
  setWebchatFns(
    (jid: string) => queue.enqueueMessageCheck(jid),
    () => channels.find(c => c.name === 'webchat') as WebchatChannel | undefined,
  );

  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  // Channels connect concurrently so a slow channel (e.g. WhatsApp pairing) doesn't block others.
  const connectableChannels: Channel[] = [];
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
    connectableChannels.push(channel);
    channels.push(channel);
    setChannels(channels);  // Update API server immediately so commands work during connect()
  }
  if (connectableChannels.length === 0) {
    logger.fatal('No channels configured');
    process.exit(1);
  }

  // Start subsystems immediately — they tolerate an empty channel list
  // via findChannel() null checks, and pick up channels as they connect.
  const schedulerDeps = {
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid: string, proc: ChildProcess, containerName: string, groupFolder: string) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid: string, rawText: string) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  };

  // In-process polling loop runs everywhere (60s precision for warm containers).
  // External cron is a fallback that wakes idle Railway containers.
  setSchedulerTickFn(() => runDueTasks(schedulerDeps));
  setSessionResetFn((folder) => { delete sessions[folder]; });
  setKillProcessFn((jid) => queue.killProcess(jid));
  startSchedulerLoop(schedulerDeps);
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
          .filter((ch) => ch.syncGroups && ch.isConnected())
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, ag, rj) =>
      writeGroupsSnapshot(gf, ag, rj),
    restartAgent: (groupFolder: string) => {
      // Write _close sentinel after 3s so the agent can finish its current
      // response (reading the install result) before shutting down.
      // On next message the agent re-spawns with updated skills loaded.
      const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
      setTimeout(() => {
        try {
          fs.mkdirSync(inputDir, { recursive: true });
          const tmpPath = path.join(inputDir, '_close.tmp');
          fs.writeFileSync(tmpPath, '');
          fs.renameSync(tmpPath, path.join(inputDir, '_close'));
          logger.info({ groupFolder }, 'Restart signal sent to agent (skill install)');
        } catch (err) {
          logger.error({ groupFolder, err }, 'Failed to send restart signal to agent');
        }
      }, 3000);
    },
  });
  queue.setProcessMessagesFn(processGroupMessages);

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
        logger.info({ jid, newFolder, isDM: chatIsDM }, 'Migrated main group registration');
      }
    }
  }

  // Connect all channels concurrently. Start the message loop as soon as
  // the first channel connects so fast channels aren't blocked by slow ones.
  let subsystemsStarted = false;
  const startSubsystemsOnce = () => {
    if (subsystemsStarted) return;
    subsystemsStarted = true;

    // Sync groups from connected channels and auto-register chats
    const syncAndRegister = async () => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups && ch.isConnected())
          .map((ch) => ch.syncGroups!(false)),
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
          else continue;

          const safeName = chat.name
            .replace(/[^a-zA-Z0-9-]/g, '-')
            .toLowerCase()
            .slice(0, 50);
          const folderName = `${prefix}_${safeName}`;
          const chatIsDM = chat.is_group === 1 ? false : inferIsDM(chat.jid);
          registerGroup(chat.jid, {
            name: chat.name,
            folder: folderName,
            trigger: `@${ASSISTANT_NAME}`,
            added_at: new Date().toISOString(),
            requiresTrigger: !chatIsDM,
            isDM: chatIsDM || undefined,
          });
          logger.debug(
            { jid: chat.jid, name: chat.name, folder: folderName, isDM: chatIsDM },
            'Auto-registered chat',
          );
        }
      }
    };

    syncAndRegister().catch((err) =>
      logger.warn({ err }, 'Initial group sync failed'),
    );

    recoverPendingMessages();
    startMessageLoop().catch((err) => {
      logger.fatal({ err }, 'Message loop crashed unexpectedly');
      process.exit(1);
    });
  };

  await Promise.allSettled(
    connectableChannels.map(async (channel) => {
      try {
        await channel.connect();
        logger.info({ channel: channel.constructor.name }, 'Channel connected');
        startSubsystemsOnce();

        // Sync groups for this newly-connected channel
        if (channel.syncGroups) {
          channel.syncGroups(false).catch((err) =>
            logger.warn({ err }, 'Post-connect group sync failed'),
          );
        }
      } catch (err) {
        logger.error({ err, channel: channel.constructor.name }, 'Channel failed to connect');
      }
    }),
  );

  // If no channels connected at all, exit
  if (!subsystemsStarted) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Signal cloud this Railway service is live (transitions status from waking/deploying → active)
  // Then drain any Telegram messages queued while service was sleeping.
  const cloudUrl = process.env.PEPPER_CLOUD_URL;
  const agentId = process.env.AGENT_ID;
  const secret = process.env.PEPPER_EVENT_SECRET;
  if (IS_RAILWAY && cloudUrl && agentId && secret) {
    const awakeBody = JSON.stringify({ startup: true });
    const awakeSignature = crypto.createHmac('sha256', secret).update(awakeBody).digest('hex');
    fetch(`${cloudUrl}/api/agents/${agentId}/awake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-event-signature': awakeSignature,
      },
      body: awakeBody,
      signal: AbortSignal.timeout(10_000),
    }).catch((err) => logger.warn({ err }, 'Failed to signal awake to cloud'));

    const tgChannel = channels.find((ch) => ch.name === 'telegram');
    if (tgChannel && 'handleUpdate' in tgChannel) {
      const { drainPendingTelegramMessages } = await import('./telegram-drain.js');
      drainPendingTelegramMessages(
        (update) => (tgChannel as { handleUpdate(u: unknown): Promise<void> }).handleUpdate(update),
      ).catch((err) => logger.warn({ err }, 'telegram-drain failed'));
    }

    const slackChannel = channels.find((ch) => ch.name === 'slack');
    if (slackChannel && 'handleSlackEvent' in slackChannel) {
      const { drainPendingSlackMessages } = await import('./slack-drain.js');
      drainPendingSlackMessages(
        (event) => (slackChannel as { handleSlackEvent(e: unknown): Promise<void> }).handleSlackEvent(event),
      ).catch((err) => logger.warn({ err }, 'slack-drain failed'));
    }
  }
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start Pepper');
    process.exit(1);
  });
}
