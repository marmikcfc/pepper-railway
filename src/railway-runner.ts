/**
 * Railway Runner for Pepper
 * Spawns agent-runner as a child Node.js process instead of Docker container.
 * Used when running on Railway (no Docker-in-Docker support).
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { createHmac } from 'crypto';

import {
  ASSISTANT_NAME,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import {
  ContainerInput,
  ContainerOutput,
  readSecrets,
} from './container-runner.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';
import { routeTask } from './task-router.js';
import { syncPersonaToClaudeMd } from './persona-composer.js';

const OUTPUT_START_MARKER = '---PEPPER_OUTPUT_START---';
const OUTPUT_END_MARKER = '---PEPPER_OUTPUT_END---';

// ─── Cloud Task Lifecycle Helpers ─────────────────────────────

function cloudHmac(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}


async function patchCloudTask(opts: {
  agentId: string;
  taskId: string;
  cloudUrl: string;
  eventSecret: string;
  status: string;
}): Promise<void> {
  const body = JSON.stringify({ status: opts.status });
  try {
    await fetch(`${opts.cloudUrl}/api/tasks/${opts.agentId}/${opts.taskId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Event-Signature': cloudHmac(opts.eventSecret, body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Non-fatal
  }
}

/**
 * Prepare workspace directories and settings (same as container-runner's
 * buildVolumeMounts, but without creating Docker mount structs).
 */
function prepareWorkspace(
  group: RegisteredGroup,
): {
  groupDir: string;
  globalDir: string | undefined;
  extraDir: string | undefined;
  ipcDir: string;
  claudeDir: string;
} {
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Sync CLAUDE.md template from image to volume.
  // global/CLAUDE.md is system config — always overwrite so deploys pick up changes.
  // Per-group CLAUDE.md is agent memory — only create once to preserve customizations.
  const templateGroupsDir = path.join(process.cwd(), 'groups');
  for (const folder of [group.folder, 'global']) {
    const targetDir = path.join(GROUPS_DIR, folder);
    const targetMd = path.join(targetDir, 'CLAUDE.md');
    const templateMd = path.join(templateGroupsDir, folder, 'CLAUDE.md');
    const shouldWrite = folder === 'global'
      ? fs.existsSync(templateMd)                              // always overwrite global
      : !fs.existsSync(targetMd) && fs.existsSync(templateMd); // only if missing for per-group
    if (shouldWrite) {
      fs.mkdirSync(targetDir, { recursive: true });
      let content = fs.readFileSync(templateMd, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(targetMd, content);
      logger.info({ folder, targetMd }, 'Synced CLAUDE.md template to volume');
    }
  }

  // Persona overlay: if the cloud has soul.md / agents.md set for this agent
  // (and/or users.md at workspace level), append the composed persona onto the
  // per-group CLAUDE.md so the runtime sees identity + procedures + workspace
  // context alongside the baseline template. No-op if env vars or persona
  // content are missing — falls back to the static template above.
  const personaCloudUrl = process.env.PEPPER_CLOUD_URL || '';
  const personaWorkspaceId = process.env.WORKSPACE_ID || '';
  const personaAgentId = process.env.AGENT_ID || '';
  const personaEventSecret = process.env.PEPPER_EVENT_SECRET || '';
  if (personaCloudUrl && personaWorkspaceId && personaAgentId && personaEventSecret) {
    void syncPersonaToClaudeMd({
      cloudUrl: personaCloudUrl,
      workspaceId: personaWorkspaceId,
      agentId: personaAgentId,
      eventSecret: personaEventSecret,
      groupDir: path.join(GROUPS_DIR, group.folder),
      appendToTemplate: true,
    }).catch(err => logger.warn({ err }, '[persona] sync failed (continuing with static template)'));
  }

  // Global memory directory (read-only for all chats)
  let globalDir: string | undefined;
  const gd = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(gd)) globalDir = gd;

  // Per-group Claude sessions directory
  const claudeDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills — copy from image, remove stale skills no longer in image
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(claudeDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    const srcSkills = new Set<string>();
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      srcSkills.add(skillDir);
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
    // Remove skills that were deleted from the image
    if (fs.existsSync(skillsDst)) {
      for (const existing of fs.readdirSync(skillsDst)) {
        if (!srcSkills.has(existing)) {
          const stalePath = path.join(skillsDst, existing);
          if (fs.statSync(stalePath).isDirectory()) {
            fs.rmSync(stalePath, { recursive: true, force: true });
          }
        }
      }
    }
  }

  // Sync .mcp.json so agent-runner can discover additional MCP servers
  const mcpJsonSrc = path.join(process.cwd(), '.mcp.json');
  if (fs.existsSync(mcpJsonSrc)) {
    fs.copyFileSync(mcpJsonSrc, path.join(claudeDir, '.mcp.json'));
  }

  // IPC directory
  const ipcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

  // Extra mounts directory (may not exist on Railway)
  const extraBase = path.join(groupDir, 'extra');
  const extraDir = fs.existsSync(extraBase) ? extraBase : undefined;

  return { groupDir, globalDir, extraDir, ipcDir, claudeDir };
}

export async function runRailwayAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const { groupDir, globalDir, extraDir, ipcDir, claudeDir } = prepareWorkspace(
    group,
  );

  const cleanupAttachments = () => {
    const attachDir = path.join(groupDir, 'attachments');
    if (fs.existsSync(attachDir)) {
      try {
        fs.rmSync(attachDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn({ err, attachDir }, 'Failed to clean up attachments dir');
      }
    }
  };

  const agentRunnerPath =
    process.env.AGENT_RUNNER_PATH ||
    path.join(process.cwd(), 'container', 'agent-runner', 'dist', 'index.js');

  const processName = `railway-${group.folder}-${Date.now()}`;

  logger.info(
    {
      group: group.name,
      processName,
      agentRunnerPath,
    },
    'Spawning Railway agent process',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Create cloud task (fire-and-forget: proceed even if this fails)
  const cloudUrl = process.env.PEPPER_CLOUD_URL || '';
  const eventSecret = process.env.PEPPER_EVENT_SECRET || '';
  const agentId = process.env.AGENT_ID || '';
  const channel = input.channel || group.folder.split('_')[0] || 'unknown';
  const origin = input.isScheduledTask ? 'dashboard' : (input.origin || 'chat');

  // Web channel: task_id is already known (passed from dashboard UI), skip routing
  // __misc__ sentinel means "misc chat, skip task routing entirely"
  const skipRouting = input.taskId === '__misc__';
  let taskId: string | null = skipRouting ? null : (input.taskId ?? null);

  if (!taskId && !skipRouting && cloudUrl && eventSecret && agentId && !input.isScheduledTask) {
    try {
      const routed = await routeTask({
        message: input.prompt,
        channel,
        origin,
        chatJid: input.chatJid,
        agentId,
        cloudUrl,
        eventSecret,
      });
      taskId = routed.taskId;
      logger.info(
        { group: group.name, taskId, action: routed.action, reasoning: routed.reasoning },
        'Task routed',
      );
    } catch (err) {
      logger.warn({ err }, 'routeTask threw unexpectedly, proceeding without task routing');
    }
  }

  return new Promise((resolve) => {
    const child = spawn('node', [agentRunnerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: groupDir,
      env: {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        NODE_PATH: process.env.NODE_PATH || '',
        TZ: TIMEZONE,
        HOME: claudeDir.replace(/\/.claude$/, ''), // Parent of .claude dir
        PEPPER_WORKSPACE_GROUP: groupDir,
        PEPPER_WORKSPACE_GLOBAL: globalDir || '',
        PEPPER_WORKSPACE_EXTRA: extraDir || '',
        PEPPER_IPC_DIR: ipcDir,
        PEPPER_IPC_INPUT: path.join(ipcDir, 'input'),
        LOG_LEVEL: process.env.LOG_LEVEL || '',
        NODE_ENV: process.env.NODE_ENV || '',
        RAILWAY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT || '',
        // Cloud task context for artifact uploader
        TASK_ID: taskId || '',
        AGENT_ID: agentId,
        WORKSPACE_ID: process.env.WORKSPACE_ID || '',
        PEPPER_CLOUD_URL: cloudUrl,
        PEPPER_EVENT_SECRET: eventSecret,
        PEPPER_CHANNEL: channel,
        // Public domain for HTML preview serving
        RAILWAY_PUBLIC_DOMAIN: process.env.RAILWAY_PUBLIC_DOMAIN || '',
      },
    });

    onProcess(child, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never exposed as env vars)
    // Also inject cloud relay vars so telemetry can read them before the
    // sanitize hook wipes them from process.env.
    const baseSecrets = readSecrets();

    // Cost-optimal subagent model overrides.
    // When the core model is NOT an Anthropic model (opus/sonnet/haiku), inject
    // cheap GPT-5.4 aliases for haiku/sonnet-tier internal tasks — up to ~10x savings.
    // Anthropic users keep their model choice intact.
    const coreModel = (baseSecrets.ANTHROPIC_MODEL || '').toLowerCase();
    const isAnthropicModel = coreModel && ['opus', 'sonnet', 'haiku'].some(m => coreModel.includes(m));
    const modelAliasOverrides: Record<string, string> = {};
    if (coreModel && !isAnthropicModel) {
      modelAliasOverrides.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'openai/gpt-5.4-nano';
      modelAliasOverrides.ANTHROPIC_DEFAULT_SONNET_MODEL = 'openai/gpt-5.4-mini';
    }

    input.secrets = {
      ...baseSecrets,
      ...modelAliasOverrides,
      ...(cloudUrl && { PEPPER_CLOUD_URL: cloudUrl }),
      ...(eventSecret && { PEPPER_EVENT_SECRET: eventSecret }),
      ...(agentId && { TENANT_ID: agentId }),
      ...(taskId && { TASK_ID: taskId }),
      ...(ASSISTANT_NAME && { ASSISTANT_NAME }),
      ...(process.env.COMPOSIO_API_KEY && { COMPOSIO_API_KEY: process.env.COMPOSIO_API_KEY }),
    };
    const secretKeyNames = Object.keys(input.secrets);
    const secretKeysWithValues = secretKeyNames.filter(
      (k) => input.secrets![k],
    );
    logger.info(
      {
        group: group.name,
        secretKeys: secretKeyNames,
        secretKeysWithValues,
        hasAnthropicKey: !!input.secrets.ANTHROPIC_API_KEY,
        hasAuthToken: !!input.secrets.ANTHROPIC_AUTH_TOKEN,
        hasBaseUrl: !!input.secrets.ANTHROPIC_BASE_URL,
        baseUrl: input.secrets.ANTHROPIC_BASE_URL || '(not set)',
        ghTokenInProcessEnv: !!process.env.GH_TOKEN,
        ghTokenInSecrets: !!input.secrets.GH_TOKEN,
        ghTokenLength: input.secrets.GH_TOKEN?.length ?? 0,
      },
      'Passing secrets to agent runner',
    );
    (input as unknown as Record<string, unknown>).secretKeyNames =
      secretKeyNames;
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
    delete input.secrets;
    delete (input as unknown as Record<string, unknown>).secretKeyNames;

    // Streaming output parsing (same protocol as container-runner)
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let timedOut = false;
    let hadStreamingOutput = false;

    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Railway agent timeout, sending SIGTERM',
      );
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          logger.warn({ group: group.name, processName }, 'Force killing');
          child.kill('SIGKILL');
        }
      }, 15000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    child.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Railway agent stdout truncated',
          );
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) newSessionId = parsed.newSessionId;
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line)
          logger.info({ process: group.folder, stream: 'stderr' }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      cleanupAttachments(); // Clean up temp attachment files
      const duration = Date.now() - startTime;

      logger.info(
        {
          group: group.name,
          processName,
          exitCode: code,
          duration,
          hadStreamingOutput,
          stderrLength: stderr.length,
          stdoutLength: stdout.length,
          stderrTail: stderr.slice(-500) || '(empty)',
        },
        'Railway agent process exited',
      );

      if (timedOut) {
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processName, duration, code },
            'Railway agent timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        resolve({
          status: 'error',
          result: null,
          error: `Railway agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      // Write log file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `railway-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Railway Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
      ];

      if (isVerbose || code !== 0) {
        logLines.push(
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, logFile },
          'Railway agent exited with error',
        );
        // Patch cloud task to failed so it doesn't stay in_progress forever
        if (taskId && cloudUrl && eventSecret && agentId) {
          patchCloudTask({ agentId, taskId, cloudUrl, eventSecret, status: 'failed' }).catch(() => {});
        }
        resolve({
          status: 'error',
          result: null,
          error: `Railway agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Patch cloud task to done (fire-and-forget)
      if (taskId && cloudUrl && eventSecret && agentId) {
        patchCloudTask({ agentId, taskId, cloudUrl, eventSecret, status: 'done' }).catch(() => {});
      }

      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Railway agent completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy mode: parse last output marker
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);
        logger.info(
          { group: group.name, duration, status: output.status },
          'Railway agent completed',
        );
        resolve(output);
      } catch (err) {
        logger.error(
          { group: group.name, stdout, stderr, error: err },
          'Failed to parse Railway agent output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, processName, error: err },
        'Railway agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Railway agent spawn error: ${err.message}`,
      });
    });
  });
}
