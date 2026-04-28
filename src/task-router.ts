import Anthropic from '@anthropic-ai/sdk'
import { createHmac } from 'crypto'

export interface OpenTask {
  id: string
  title: string | null
  summary: string | null
  channel: string
  recent_messages: Array<{ role: 'user' | 'agent'; text: string; ts: string }>
}

export interface LLMDecision {
  action: 'attach' | 'new' | 'misc'
  task_id?: string
  confidence: number
  reasoning: string
}

export interface RouteResult {
  taskId: string | null
  action: 'attach' | 'new' | 'misc'
  reasoning: string
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

/**
 * Build the prompt for the Haiku classification call.
 * Exported for unit testing.
 */
export function buildPrompt(message: string, channel: string, tasks: OpenTask[]): string {
  const taskList = tasks
    .map((t) => {
      const msgs = t.recent_messages
        .map((m) => `  ${m.role}: ${m.text.slice(0, 200)}`)
        .join('\n')
      return [
        `[${t.id}] "${t.title ?? 'Untitled'}" (${t.channel})`,
        t.summary ? `Summary: ${t.summary}` : null,
        msgs ? `Recent:\n${msgs}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')

  return `You are a task router for an AI agent. Route the incoming message to the right task.

Open tasks:
${taskList}

Incoming message (channel: ${channel}):
"${message}"

Rules:
- attach: message clearly continues an existing task (confidence >= 0.65 required)
- new: unrelated request or ambiguous match
- misc: greeting, casual chat, or unclassifiable`
}

/**
 * Apply the LLM decision to the open task list.
 * Exported for unit testing.
 */
export function selectTask(decision: LLMDecision, tasks: OpenTask[]): RouteResult {
  if (decision.action === 'attach' && decision.confidence >= 0.65) {
    const matched = tasks.find((t) => t.id === decision.task_id)
    if (matched) {
      return { taskId: matched.id, action: 'attach', reasoning: decision.reasoning }
    }
  }
  if (decision.action === 'misc') {
    return { taskId: null, action: 'misc', reasoning: decision.reasoning }
  }
  return { taskId: null, action: 'new', reasoning: decision.reasoning }
}

async function fetchOpenTasks(
  cloudUrl: string,
  agentId: string,
  eventSecret: string,
): Promise<OpenTask[]> {
  const resp = await fetch(`${cloudUrl}/api/tasks/${agentId}/open`, {
    headers: { 'x-event-signature': sign(eventSecret, '') },
    signal: AbortSignal.timeout(10_000),
  })
  if (!resp.ok) return []
  const json = (await resp.json()) as { tasks: OpenTask[] }
  return json.tasks ?? []
}

/** Extract the human-readable message from an XML-wrapped prompt, falling back to raw. */
function extractMessage(raw: string): string {
  const match = /<message\b[^>]*>([\s\S]*?)<\/message>/.exec(raw)
  return (match ? match[1] : raw).trim()
}

export async function createCloudTask(
  cloudUrl: string,
  agentId: string,
  eventSecret: string,
  opts: { message?: string; channel: string; origin?: string; chatJid: string; isMisc?: boolean },
): Promise<string | null> {
  const body = JSON.stringify({
    title: opts.isMisc ? undefined : (opts.message ? extractMessage(opts.message).slice(0, 80) : undefined),
    channel: opts.channel,
    ...(opts.origin && { origin: opts.origin }),
    chat_jid: opts.chatJid,
    ...(opts.isMisc && { is_misc: true }),
  })
  const resp = await fetch(`${cloudUrl}/api/tasks/${agentId}/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-event-signature': sign(eventSecret, body),
    },
    body,
    signal: AbortSignal.timeout(10_000),
  })
  if (!resp.ok) return null
  const json = (await resp.json()) as { task_id: string }
  return json.task_id ?? null
}

export async function routeTask(opts: {
  message: string
  channel: string
  origin: string
  chatJid: string
  agentId: string
  cloudUrl: string
  eventSecret: string
}): Promise<RouteResult> {
  const { message, channel, origin, chatJid, agentId, cloudUrl, eventSecret } = opts

  try {
    const tasks = await fetchOpenTasks(cloudUrl, agentId, eventSecret)

    if (tasks.length === 0) {
      const taskId = await createCloudTask(cloudUrl, agentId, eventSecret, { message, channel, origin, chatJid })
      return { taskId, action: 'new', reasoning: 'No open tasks — created new task' }
    }

    const headers: Record<string, string> = {
      'HTTP-Referer': 'https://pepper.cloud',
    }
    if (process.env.OPENROUTER_TITLE) {
      headers['X-OpenRouter-Title'] = process.env.OPENROUTER_TITLE
    }
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, defaultHeaders: headers })
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      tools: [
        {
          name: 'route_message',
          description: 'Route an incoming message to the appropriate task',
          input_schema: {
            type: 'object' as const,
            properties: {
              action: { type: 'string', enum: ['attach', 'new', 'misc'] },
              task_id: { type: 'string', description: 'UUID of existing task (required when action=attach)' },
              confidence: { type: 'number', description: 'Confidence score 0-1' },
              reasoning: { type: 'string' },
            },
            required: ['action', 'confidence', 'reasoning'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'route_message' },
      messages: [{ role: 'user', content: buildPrompt(message, channel, tasks) }],
    })

    const toolUse = response.content.find((b) => b.type === 'tool_use')
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error('No tool use in LLM response')
    }

    const decision = toolUse.input as LLMDecision
    const selected = selectTask(decision, tasks)

    if (selected.action === 'attach') {
      return { ...selected, taskId: selected.taskId }
    }

    // new or misc — create task in cloud
    const taskId = await createCloudTask(cloudUrl, agentId, eventSecret, {
      message,
      channel,
      origin,
      chatJid,
      isMisc: selected.action === 'misc',
    })
    return { ...selected, taskId }
  } catch (err) {
    // Non-fatal: fall back to creating a new task
    const taskId = await createCloudTask(cloudUrl, agentId, eventSecret, {
      message, channel, origin, chatJid,
    }).catch(() => null)
    return {
      taskId,
      action: 'new',
      reasoning: `Router error — fallback: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
