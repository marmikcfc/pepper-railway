// pepper-railway/src/pepper-tasks/runner.ts
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger.js';
import { PEPPER_TOOLS, executeTool } from './tools.js';

const MAX_TURNS = 20;

interface PepperTaskPayload {
  integrationId: string;
  eventType: string;
  payload: {
    message: string;
    workspaceId: string;
    userId: string;
    context: {
      workspace: {
        name: string;
        website_url?: string;
        twitter_url?: string;
        linkedin_url?: string;
        github_url?: string;
        company_profile?: Record<string, unknown>;
      };
      agents: Array<{ id: string; agent_name: string; role: string | null; status: string }>;
      tasks: { inbox: number; in_progress: number; blocked: number; done: number };
      credits: number;
      user: { id: string; email?: string };
    };
  };
}

function buildSystemPrompt(payload: PepperTaskPayload): string {
  const { context } = payload.payload;
  const ws = context.workspace;

  const agentList = context.agents.length > 0
    ? context.agents.map(a => `  - ${a.agent_name} (${a.role ?? 'no role'}, ${a.status})`).join('\n')
    : '  (none)';

  const companySection = ws.company_profile
    ? `\n## Existing Company Profile\n${JSON.stringify(ws.company_profile, null, 2)}\n`
    : '';

  return `You are Pepper's compute engine — you run inside a dedicated Railway service.
You handle heavy, long-running tasks that Cloud Pepper offloads to you.
You have access to research tools (web search, URL fetch, GitHub), memory write, and agent provisioning.

## Current Task
${payload.payload.message}

## Workspace Context
- Company: ${ws.name}
- Website: ${ws.website_url ?? 'not provided'}
- Twitter: ${ws.twitter_url ?? 'not provided'}
- LinkedIn: ${ws.linkedin_url ?? 'not provided'}
- GitHub: ${ws.github_url ?? 'not provided'}
- Credits: $${context.credits.toFixed(2)}
- Team:
${agentList}
- Tasks: ${context.tasks.inbox} inbox, ${context.tasks.in_progress} active, ${context.tasks.blocked} blocked
- User ID: ${context.user.id}
- Workspace ID: ${payload.payload.workspaceId}
${companySection}

## Instructions
- Work autonomously. Use your tools to gather information and complete the task.
- For company research: fetch the website, search for competitors and news, check GitHub if URL provided, read social signals.
- When research is complete, call write_memory with a structured JSON company profile covering: product, tech stack, positioning, target customers, competitors, social presence.
- For hire_team tasks: use provision_agent for each team member, then summarize what you hired.
- Be thorough but efficient — use parallel-style reasoning across multiple searches.
- workspaceId for tool calls: ${payload.payload.workspaceId}
- userId for tool calls: ${payload.payload.userId}`;
}

export async function runPepperRailwayAgent(body: unknown): Promise<void> {
  const payload = body as PepperTaskPayload;

  if (!payload?.payload?.message) {
    logger.warn('Pepper Railway received webhook-event with no message — skipping');
    return;
  }

  const { workspaceId, message } = payload.payload;
  logger.info({ workspaceId, message: message.slice(0, 100) }, 'Pepper Railway agent starting');

  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey) {
    logger.error('No Anthropic API key configured (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN)');
    return;
  }

  const extraHeaders: Record<string, string> = {};
  if (process.env.OPENROUTER_TITLE) {
    extraHeaders['X-Title'] = process.env.OPENROUTER_TITLE;
  }

  const anthropic = new Anthropic({
    apiKey,
    baseURL: process.env.ANTHROPIC_BASE_URL,
    defaultHeaders: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
  });

  const systemPrompt = buildSystemPrompt(payload);
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: message },
  ];

  let turn = 0;

  while (turn < MAX_TURNS) {
    turn++;
    logger.info({ workspaceId, turn }, 'Pepper Railway agent turn');

    const response = await anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 8096,
      system: systemPrompt,
      tools: PEPPER_TOOLS.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })),
      messages,
    });

    logger.info({ workspaceId, turn, stop_reason: response.stop_reason }, 'Pepper Railway agent response');

    // Add assistant response to history
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      logger.info({ workspaceId, result: (textBlock as any)?.text?.slice(0, 200) }, 'Pepper Railway agent complete');
      break;
    }

    if (response.stop_reason !== 'tool_use') {
      logger.warn({ workspaceId, stop_reason: response.stop_reason }, 'Unexpected stop reason');
      break;
    }

    // Execute tool calls
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      logger.info({ workspaceId, tool: block.name, input: JSON.stringify(block.input).slice(0, 200) }, 'Executing tool');
      const result = await executeTool(block.name, block.input as Record<string, unknown>);
      logger.info({ workspaceId, tool: block.name, result: result.slice(0, 200) }, 'Tool result');

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  if (turn >= MAX_TURNS) {
    logger.warn({ workspaceId }, 'Pepper Railway agent hit max turns');
  }
}
