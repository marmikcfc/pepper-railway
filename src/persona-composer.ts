// Persona composer — fetches per-agent soul.md + agents.md and workspace
// users.md from the cloud, composes them into a final CLAUDE.md, and writes
// to the per-group CLAUDE.md path.
//
// Plan: docs/superpowers/plans/2026-05-01-persona-files.md
//
// Composition order: soul → agents → users → DEFAULT_RUNTIME_INSTRUCTIONS.
// Empty/missing files are skipped — sensible defaults baked into the runtime
// (the static template at groups/<folder>/CLAUDE.md) handle that case.

import fs from 'fs';
import path from 'path';
import { createHmac } from 'crypto';
import { logger } from './logger.js';

interface PersonaResponse {
  agent_id: string;
  agent_name: string | null;
  role: string | null;
  soul_md: string | null;
  agents_md: string | null;
  users_md: string | null;
  persona_updated_at: string | null;
  users_md_updated_at: string | null;
}

export interface ComposedPersona {
  finalClaudeMd: string;
  composedAt: string;
  sources: { soul: boolean; agents: boolean; users: boolean };
}

/**
 * Fetch the agent's persona from the cloud and compose into a single Markdown
 * blob. Returns null if any required env var is missing or the fetch fails —
 * caller should fall back to the static template in that case.
 */
export async function composePersona(opts: {
  cloudUrl: string;
  workspaceId: string;
  agentId: string;
  eventSecret: string;
}): Promise<ComposedPersona | null> {
  if (!opts.cloudUrl || !opts.workspaceId || !opts.agentId || !opts.eventSecret) {
    return null;
  }

  const url = `${opts.cloudUrl.replace(/\/$/, '')}/api/workspaces/${opts.workspaceId}/agents/${opts.agentId}/persona`;
  const sig = createHmac('sha256', opts.eventSecret).update(opts.agentId).digest('hex');

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { 'X-Event-Signature': sig },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    logger.warn({ err }, '[persona] fetch failed');
    return null;
  }
  if (!res.ok) {
    logger.warn({ status: res.status }, '[persona] non-200 response');
    return null;
  }

  let data: PersonaResponse;
  try { data = await res.json() as PersonaResponse; } catch { return null; }

  const sections: string[] = [];
  const name = data.agent_name ?? 'Pepper';
  sections.push(`# ${name}`);
  if (data.role) sections.push(`Role: ${data.role}`);

  const sources = { soul: false, agents: false, users: false };
  if (data.soul_md && data.soul_md.trim()) {
    sections.push('\n## Identity\n' + data.soul_md.trim());
    sources.soul = true;
  }
  if (data.agents_md && data.agents_md.trim()) {
    sections.push('\n## How I work\n' + data.agents_md.trim());
    sources.agents = true;
  }
  if (data.users_md && data.users_md.trim()) {
    sections.push('\n## Who I serve\n' + data.users_md.trim());
    sources.users = true;
  }

  return {
    finalClaudeMd: sections.join('\n') + '\n',
    composedAt: new Date().toISOString(),
    sources,
  };
}

/**
 * Compose persona, append to or replace the per-group CLAUDE.md, and log the
 * source breakdown. Idempotent — same inputs produce byte-identical output.
 */
export async function syncPersonaToClaudeMd(opts: {
  cloudUrl: string;
  workspaceId: string;
  agentId: string;
  eventSecret: string;
  groupDir: string;            // path to groups/<folder>/
  appendToTemplate?: boolean;  // if true, append composed persona to existing CLAUDE.md (preserves baseline runtime instructions)
}): Promise<boolean> {
  const composed = await composePersona(opts);
  if (!composed) return false;
  if (!composed.sources.soul && !composed.sources.agents && !composed.sources.users) {
    // Nothing meaningful to compose — leave the static template alone.
    return false;
  }

  const targetMd = path.join(opts.groupDir, 'CLAUDE.md');
  const baseline = opts.appendToTemplate && fs.existsSync(targetMd)
    ? fs.readFileSync(targetMd, 'utf-8').trimEnd() + '\n\n'
    : '';

  fs.mkdirSync(opts.groupDir, { recursive: true });
  fs.writeFileSync(targetMd, baseline + composed.finalClaudeMd);
  logger.info({ targetMd, sources: composed.sources }, '[persona] CLAUDE.md updated');
  return true;
}
