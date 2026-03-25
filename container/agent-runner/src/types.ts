// Agent-runner types only — no Zod here (Zod validation lives in the cloud gateway).
// The agent-runner is the sender; validation happens on the receiving end.

export const EventTypes = [
  'query_start', 'reasoning', 'tool_call', 'tool_result',
  'subagent_start', 'subagent_end', 'response', 'error', 'artifact',
] as const;

export type EventType = (typeof EventTypes)[number];
export type EventStatus = 'pending' | 'complete' | 'error';

// Discriminated union for event-specific data payloads
export type EventData =
  | { type: 'query_start'; prompt: string; channel: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; tool_name: string; tool_input: Record<string, unknown>; tool_use_id: string }
  | { type: 'tool_result'; tool_use_id: string; output: string; is_error: boolean; truncated?: boolean }
  | { type: 'subagent_start'; task_id: string; task_description: string }
  | { type: 'subagent_end'; task_id: string; status: 'completed' | 'failed' | 'stopped' }
  | { type: 'response'; text: string; is_error: boolean }
  | { type: 'error'; error_type: string; message: string }
  | {
      type: 'artifact';
      artifact_id: string;
      filename: string;
      title?: string;
      ephemeral_url: string;
      mime_type: string;
      size_bytes: number;
    };

export interface AgentEvent {
  id: string;
  tenant_id: string;
  trace_id: string;
  parent_event_id: string | null;
  seq: number;
  event_type: EventType;
  status: EventStatus;
  agent_name: string;
  channel: string;
  task_id: string | null;
  data: EventData;
  tokens_used: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  client_ts: string; // ISO 8601
}

const DATA_MAX_BYTES = 65536; // 64KB

export function truncateEventData(data: EventData): EventData {
  const json = JSON.stringify(data);
  if (json.length <= DATA_MAX_BYTES) return data;

  if (data.type === 'tool_result') {
    const maxOutput = DATA_MAX_BYTES - 200; // leave room for other fields
    return { ...data, output: data.output.slice(0, maxOutput), truncated: true };
  }
  if (data.type === 'reasoning') {
    return { ...data, text: data.text.slice(0, DATA_MAX_BYTES - 100) };
  }
  return data;
}
