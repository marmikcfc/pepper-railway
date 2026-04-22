// pepper-railway/src/pepper-tasks/tools.ts
import { logger } from '../logger.js';

export interface PepperTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
}

export const PEPPER_TOOLS: PepperTool[] = [
  {
    name: 'web_search',
    description: 'Search the web for information about a company, market, technology, or topic.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        num_results: { type: 'number', description: 'Number of results (1-10, default: 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_url',
    description: 'Fetch and extract text content from a URL. Use for company websites, blog posts, product pages.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
      },
      required: ['url'],
    },
  },
  {
    name: 'github_fetch',
    description: 'Fetch public GitHub information. If repo is omitted, lists the owner\'s top repositories. If repo is provided, returns README, languages, and description for that specific repository.',
    input_schema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'GitHub org or username' },
        repo: { type: 'string', description: 'Repository name (omit to list top repos for the owner)' },
      },
      required: ['owner'],
    },
  },
  {
    name: 'write_memory',
    description: 'Write the company profile and research findings to workspace memory. Call this once when research is complete.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: ['company_profile'], description: 'Memory key to write' },
        value: { type: 'object', description: 'Structured company profile object to store' },
        workspace_id: { type: 'string', description: 'Workspace ID' },
      },
      required: ['key', 'value', 'workspace_id'],
    },
  },
  {
    name: 'provision_agent',
    description: 'Hire a new agent for this workspace. Use for hire_team tasks.',
    input_schema: {
      type: 'object',
      properties: {
        agent_name: { type: 'string', description: 'Agent name' },
        role: { type: 'string', description: 'Agent role or job title' },
        workspace_id: { type: 'string', description: 'Workspace ID' },
        user_id: { type: 'string', description: 'User ID (from context)' },
      },
      required: ['agent_name', 'role', 'workspace_id', 'user_id'],
    },
  },
];

export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case 'web_search':
        return await executeWebSearch(String(input.query ?? ''), Number(input.num_results ?? 5));
      case 'fetch_url':
        return await executeFetchUrl(String(input.url ?? ''));
      case 'github_fetch':
        return await executeGithubFetch(String(input.owner ?? ''), input.repo != null ? String(input.repo) : undefined);
      case 'write_memory':
        return await executeWriteMemory(String(input.workspace_id ?? ''), String(input.key ?? 'company_profile'), input.value);
      case 'provision_agent':
        return await executeProvisionAgent(input);
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, tool: name }, 'Tool execution error');
    return JSON.stringify({ error: message });
  }
}

async function executeWebSearch(query: string, numResults: number): Promise<string> {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) {
    return JSON.stringify({ error: 'EXA_API_KEY not configured' });
  }

  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      query,
      num_results: Math.min(numResults || 5, 10),
      use_autoprompt: true,
      contents: { text: { max_characters: 1000 } },
    }),
  });

  if (!res.ok) {
    return JSON.stringify({ error: `Exa search failed: ${res.status}` });
  }

  const data = await res.json() as { results?: Array<{ title: string; url: string; text?: string }> };
  const results = (data.results ?? []).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.text?.slice(0, 500) ?? '',
  }));

  return JSON.stringify({ results });
}

async function executeFetchUrl(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PepperBot/1.0)' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    return JSON.stringify({ error: `Fetch failed: ${res.status}` });
  }

  const html = await res.text();
  // Strip HTML tags and collapse whitespace
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);

  return JSON.stringify({ url, content: text });
}

async function executeGithubFetch(owner: string, repo?: string): Promise<string> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'PepperBot/1.0',
  };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  if (!repo) {
    // List repos for owner
    const res = await fetch(`https://api.github.com/users/${owner}/repos?sort=updated&per_page=10`, { headers });
    if (!res.ok) return JSON.stringify({ error: `GitHub API failed: ${res.status}` });
    const repos = await res.json() as Array<{ name: string; description: string; language: string; stargazers_count: number; html_url: string }>;
    return JSON.stringify({
      owner,
      repos: repos.map(r => ({
        name: r.name,
        description: r.description,
        language: r.language,
        stars: r.stargazers_count,
        url: r.html_url,
      })),
    });
  }

  // Fetch specific repo
  const [repoRes, readmeRes, langsRes] = await Promise.allSettled([
    fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
      headers: { ...headers, 'Accept': 'application/vnd.github.v3.raw' },
    }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/languages`, { headers }),
  ]);

  const repoData = repoRes.status === 'fulfilled' && repoRes.value.ok
    ? await repoRes.value.json() as { description: string; stargazers_count: number; topics: string[] }
    : null;

  const readme = readmeRes.status === 'fulfilled' && readmeRes.value.ok
    ? (await readmeRes.value.text()).slice(0, 4000)
    : '(not available)';

  const langs = langsRes.status === 'fulfilled' && langsRes.value.ok
    ? await langsRes.value.json()
    : {};

  return JSON.stringify({
    owner,
    repo,
    description: repoData?.description,
    stars: repoData?.stargazers_count,
    topics: repoData?.topics,
    languages: langs,
    readme,
  });
}

async function executeWriteMemory(workspaceId: string, _key: string, value: unknown): Promise<string> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return JSON.stringify({ error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) {
    return JSON.stringify({ error: 'Invalid workspace_id format' });
  }

  const companyProfile = value;

  const res = await fetch(`${supabaseUrl}/rest/v1/workspaces?id=eq.${encodeURIComponent(workspaceId)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceRoleKey,
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ company_profile: companyProfile, pepper_onboarded: true }),
  });

  if (!res.ok) {
    return JSON.stringify({ error: `Supabase write failed: ${res.status}` });
  }

  logger.info({ workspaceId }, 'Company profile written to workspace, pepper_onboarded=true');
  return JSON.stringify({ success: true, workspace_id: workspaceId });
}

async function executeProvisionAgent(input: Record<string, unknown>): Promise<string> {
  const cloudUrl = process.env.PEPPER_CLOUD_URL;
  const platformToken = process.env.PEPPER_PLATFORM_TOKEN;

  if (!cloudUrl || !platformToken) {
    return JSON.stringify({ error: 'PEPPER_CLOUD_URL or PEPPER_PLATFORM_TOKEN not configured' });
  }

  const res = await fetch(`${cloudUrl}/api/internal/provision-agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${platformToken}`,
    },
    body: JSON.stringify({
      wsId: String(input.workspace_id ?? ''),
      userId: String(input.user_id ?? ''),
      agent_name: String(input.agent_name ?? ''),
      role: String(input.role ?? ''),
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    return JSON.stringify({ error: (data as any).error ?? `Provision failed: ${res.status}` });
  }

  return JSON.stringify(data);
}
