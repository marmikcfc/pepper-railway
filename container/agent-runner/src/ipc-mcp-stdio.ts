/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'manage_skills',
  'Manage agent skills. Actions: "add" installs skills from a GitHub repo (requires repo param), "remove" removes a skill by name, "list" shows all installed skills. A progress message is sent to the user for add. After adding, use send_message to tell the user what was installed and ask for any missing credentials — do NOT wait for your final output.',
  {
    action: z.enum(['add', 'remove', 'list']).describe('Action to perform'),
    repo: z.string().optional().describe('GitHub repo (owner/repo or full URL) — required for "add"'),
    name: z.string().optional().describe('Skill name — required for "remove"'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can manage skills.' }],
        isError: true,
      };
    }

    const INPUT_DIR = path.join(IPC_DIR, 'input');
    const timeout = 120_000;
    const pollInterval = 500;

    if (args.action === 'add') {
      if (!args.repo) {
        return {
          content: [{ type: 'text' as const, text: 'The "repo" parameter is required for the "add" action.' }],
          isError: true,
        };
      }

      // Send a progress message to the user immediately
      writeIpcFile(MESSAGES_DIR, {
        type: 'message',
        chatJid,
        text: `Installing skills from \`${args.repo}\`...`,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      const requestId = `skill-install-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      writeIpcFile(TASKS_DIR, {
        type: 'install_skills',
        repo: args.repo,
        requestId,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      const responseFile = path.join(INPUT_DIR, `${requestId}.json`);
      const start = Date.now();

      while (Date.now() - start < timeout) {
        if (fs.existsSync(responseFile)) {
          try {
            const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
            fs.unlinkSync(responseFile);

            if (result.error) {
              return {
                content: [{ type: 'text' as const, text: `Failed to install skills: ${result.error}` }],
                isError: true,
              };
            }

            let response = `Installed ${result.installed.length} skill(s): ${result.installed.join(', ')}`;
            if (result.requiredInputs && result.requiredInputs.length > 0) {
              response += '\n\nRequired environment variables:';
              for (const input of result.requiredInputs) {
                response += `\n- ${input.envVar}: ${input.description}${input.required ? ' (required)' : ' (optional)'}`;
              }
              response += '\n\nUse the set_env_var tool to set each required credential.';
            }

            return { content: [{ type: 'text' as const, text: response }] };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Error reading install result: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }

      return {
        content: [{ type: 'text' as const, text: 'Timed out waiting for skill installation to complete.' }],
        isError: true,
      };
    }

    if (args.action === 'remove') {
      if (!args.name) {
        return {
          content: [{ type: 'text' as const, text: 'The "name" parameter is required for the "remove" action.' }],
          isError: true,
        };
      }

      const requestId = `skill-remove-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      writeIpcFile(TASKS_DIR, {
        type: 'remove_skill',
        name: args.name,
        requestId,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      const responseFile = path.join(INPUT_DIR, `${requestId}.json`);
      const start = Date.now();

      while (Date.now() - start < timeout) {
        if (fs.existsSync(responseFile)) {
          try {
            const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
            fs.unlinkSync(responseFile);

            if (result.error) {
              return {
                content: [{ type: 'text' as const, text: `Failed to remove skill: ${result.error}` }],
                isError: true,
              };
            }

            return {
              content: [{ type: 'text' as const, text: result.removed ? `Skill "${args.name}" removed.` : `Skill "${args.name}" not found.` }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Error reading remove result: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }

      return {
        content: [{ type: 'text' as const, text: 'Timed out waiting for skill removal to complete.' }],
        isError: true,
      };
    }

    // list
    const requestId = `skill-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(TASKS_DIR, {
      type: 'list_skills',
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const responseFile = path.join(INPUT_DIR, `${requestId}.json`);
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (fs.existsSync(responseFile)) {
        try {
          const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          fs.unlinkSync(responseFile);

          if (result.error) {
            return {
              content: [{ type: 'text' as const, text: `Failed to list skills: ${result.error}` }],
              isError: true,
            };
          }

          if (!result.skills || result.skills.length === 0) {
            return { content: [{ type: 'text' as const, text: 'No skills installed.' }] };
          }

          let response = `Installed skills (${result.skills.length}):`;
          for (const skill of result.skills) {
            response += `\n- ${skill.name} (source: ${skill.source}, type: ${skill.sourceType})`;
          }
          return { content: [{ type: 'text' as const, text: response }] };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error reading list result: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return {
      content: [{ type: 'text' as const, text: 'Timed out waiting for skill list.' }],
      isError: true,
    };
  },
);

server.tool(
  'manage_mcp_servers',
  'Manage MCP (Model Context Protocol) servers. Actions: "add" registers a new MCP server (requires name, command, args), "remove" removes a server by name, "list" shows all registered servers. Servers persist across restarts. After adding, use set_env_var to set any required credentials.',
  {
    action: z.enum(['add', 'remove', 'list']).describe('Action to perform'),
    name: z.string().optional().describe('Server name — required for "add" and "remove"'),
    command: z.string().optional().describe('Command to run the server (e.g., "npx") — required for "add"'),
    args: z.array(z.string()).optional().describe('Command arguments (e.g., ["-y", "@hubspot/mcp-server"]) — required for "add"'),
    env: z.record(z.string(), z.string()).optional().describe('Environment variables (e.g., {"HUBSPOT_TOKEN": "${HUBSPOT_TOKEN}"}) — optional for "add"'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can manage MCP servers.' }],
        isError: true,
      };
    }

    const INPUT_DIR = path.join(IPC_DIR, 'input');
    const timeout = 30_000;
    const pollInterval = 500;

    if (args.action === 'add') {
      if (!args.name || !args.command || !args.args) {
        return {
          content: [{ type: 'text' as const, text: 'The "name", "command", and "args" parameters are required for the "add" action.' }],
          isError: true,
        };
      }

      // Send a progress message to the user immediately
      writeIpcFile(MESSAGES_DIR, {
        type: 'message',
        chatJid,
        text: `Adding MCP server \`${args.name}\`...`,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      const requestId = `mcp-add-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      writeIpcFile(TASKS_DIR, {
        type: 'add_mcp_server',
        name: args.name,
        command: args.command,
        args: args.args,
        env: args.env,
        requestId,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      const responseFile = path.join(INPUT_DIR, `${requestId}.json`);
      const start = Date.now();

      while (Date.now() - start < timeout) {
        if (fs.existsSync(responseFile)) {
          try {
            const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
            fs.unlinkSync(responseFile);

            if (result.error) {
              return {
                content: [{ type: 'text' as const, text: `Failed to add MCP server: ${result.error}` }],
                isError: true,
              };
            }

            let response = `MCP server "${args.name}" added successfully.`;
            if (result.envVarsNeeded && result.envVarsNeeded.length > 0) {
              response += `\n\nRequired environment variables: ${result.envVarsNeeded.join(', ')}`;
              response += '\n\nUse the set_env_var tool to set each required credential.';
            }
            response += '\n\nNote: The server will be available on the next agent invocation.';

            return { content: [{ type: 'text' as const, text: response }] };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Error reading add result: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }

      return {
        content: [{ type: 'text' as const, text: 'Timed out waiting for MCP server registration.' }],
        isError: true,
      };
    }

    if (args.action === 'remove') {
      if (!args.name) {
        return {
          content: [{ type: 'text' as const, text: 'The "name" parameter is required for the "remove" action.' }],
          isError: true,
        };
      }

      const requestId = `mcp-remove-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      writeIpcFile(TASKS_DIR, {
        type: 'remove_mcp_server',
        name: args.name,
        requestId,
        groupFolder,
        timestamp: new Date().toISOString(),
      });

      const responseFile = path.join(INPUT_DIR, `${requestId}.json`);
      const start = Date.now();

      while (Date.now() - start < timeout) {
        if (fs.existsSync(responseFile)) {
          try {
            const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
            fs.unlinkSync(responseFile);

            if (result.error) {
              return {
                content: [{ type: 'text' as const, text: `Failed to remove MCP server: ${result.error}` }],
                isError: true,
              };
            }

            return {
              content: [{ type: 'text' as const, text: result.removed ? `MCP server "${args.name}" removed.` : `MCP server "${args.name}" not found.` }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Error reading remove result: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }

      return {
        content: [{ type: 'text' as const, text: 'Timed out waiting for MCP server removal.' }],
        isError: true,
      };
    }

    // list
    const requestId = `mcp-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    writeIpcFile(TASKS_DIR, {
      type: 'list_mcp_servers',
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    const responseFile = path.join(INPUT_DIR, `${requestId}.json`);
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (fs.existsSync(responseFile)) {
        try {
          const result = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
          fs.unlinkSync(responseFile);

          if (result.error) {
            return {
              content: [{ type: 'text' as const, text: `Failed to list MCP servers: ${result.error}` }],
              isError: true,
            };
          }

          if (!result.servers || result.servers.length === 0) {
            return { content: [{ type: 'text' as const, text: 'No MCP servers registered.' }] };
          }

          let response = `Registered MCP servers (${result.servers.length}):`;
          for (const server of result.servers) {
            response += `\n- ${server.name}: ${server.command} ${(server.args || []).join(' ')}`;
            if (server.env && Object.keys(server.env).length > 0) {
              response += ` (env: ${Object.keys(server.env).join(', ')})`;
            }
          }
          return { content: [{ type: 'text' as const, text: response }] };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error reading list result: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return {
      content: [{ type: 'text' as const, text: 'Timed out waiting for MCP server list.' }],
      isError: true,
    };
  },
);

server.tool(
  'set_env_var',
  'Set an environment variable for the bot (persists across restarts). Use this to store credentials needed by skills. Main group only.',
  {
    key: z.string().describe('Environment variable name (e.g. OUTBOUND_TOOLS_URL)'),
    value: z.string().describe('The value to set'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can set environment variables.' }],
        isError: true,
      };
    }

    // Validate key is safe (alphanumeric + underscore only)
    if (!/^[A-Z][A-Z0-9_]*$/.test(args.key)) {
      return {
        content: [{ type: 'text' as const, text: `Invalid env var name "${args.key}". Must be uppercase alphanumeric with underscores (e.g. MY_API_KEY).` }],
        isError: true,
      };
    }

    writeIpcFile(TASKS_DIR, {
      type: 'set_env_var',
      key: args.key,
      value: args.value,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: `Environment variable ${args.key} set. It will be available to agents on next invocation.` }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
