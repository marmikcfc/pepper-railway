import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

interface SkillsLock {
  version: number;
  skills: Record<string, { source: string; sourceType: string }>;
}

/**
 * Persistent path for skills-lock.json.
 * Lives in DATA_DIR (Railway persistent volume or local data/) so it survives deploys.
 */
function lockFilePath(): string {
  return path.join(DATA_DIR, 'skills-lock.json');
}

function readLockFile(): SkillsLock {
  const lockPath = lockFilePath();
  if (fs.existsSync(lockPath)) {
    try {
      return JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    } catch {
      // Corrupt, start fresh
    }
  }
  return { version: 1, skills: {} };
}

function writeLockFile(lock: SkillsLock): void {
  const lockPath = lockFilePath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

export interface SkillInput {
  name: string;
  description: string;
  envVar: string;
  required: boolean;
}

export interface InstallSkillsResult {
  installed: string[];
  requiredInputs: SkillInput[];
  error?: string;
}

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Returns the frontmatter as a plain object, or null if none found.
 */
function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');

  let currentKey: string | null = null;
  let currentList: unknown[] | null = null;
  let currentItem: Record<string, unknown> | null = null;

  for (const line of lines) {
    // Top-level key: value
    const kvMatch = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      // Flush previous list
      if (currentKey && currentList) {
        if (currentItem) currentList.push(currentItem);
        result[currentKey] = currentList;
      }
      currentKey = kvMatch[1];
      currentList = null;
      currentItem = null;
      const value = kvMatch[2].trim();
      if (value) {
        // Strip quotes
        result[currentKey] = value.replace(/^["']|["']$/g, '');
      }
      continue;
    }

    // List item start: "  - name: value" or "  - value"
    const listItemMatch = line.match(/^\s+-\s+(\w[\w-]*)\s*:\s*(.*)$/);
    if (listItemMatch && currentKey) {
      if (!currentList) currentList = [];
      if (currentItem) currentList.push(currentItem);
      currentItem = {
        [listItemMatch[1]]: listItemMatch[2].trim().replace(/^["']|["']$/g, ''),
      };
      continue;
    }

    // Plain list item: "  - value"
    const plainListMatch = line.match(/^\s+-\s+(.+)$/);
    if (plainListMatch && currentKey && !currentItem) {
      if (!currentList) currentList = [];
      currentList.push(plainListMatch[1].trim().replace(/^["']|["']$/g, ''));
      continue;
    }

    // Nested key inside a list item: "    key: value"
    const nestedMatch = line.match(/^\s{4,}(\w[\w-]*)\s*:\s*(.*)$/);
    if (nestedMatch && currentItem) {
      currentItem[nestedMatch[1]] = nestedMatch[2]
        .trim()
        .replace(/^["']|["']$/g, '');
      continue;
    }
  }

  // Flush last list
  if (currentKey && currentList) {
    if (currentItem) currentList.push(currentItem);
    result[currentKey] = currentList;
  }

  return result;
}

/**
 * Extract required inputs (env vars) from parsed frontmatter.
 */
function extractInputs(frontmatter: Record<string, unknown>): SkillInput[] {
  const inputs = frontmatter.inputs;
  if (!Array.isArray(inputs)) return [];

  return inputs
    .filter(
      (item): item is Record<string, string> =>
        typeof item === 'object' && item !== null && 'name' in item,
    )
    .map((item) => ({
      name: item.name,
      description: item.description || '',
      envVar: item.name, // Input names ARE the env var names
      required: item.required !== 'false',
    }));
}

/**
 * Recursively find all SKILL.md files in a directory.
 */
function findSkillFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    for (const entry of fs.readdirSync(current)) {
      // Skip hidden dirs and node_modules
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const fullPath = path.join(current, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (entry === 'SKILL.md') {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

/**
 * Collect required inputs from all SKILL.md files in a directory.
 */
function collectInputsFromDir(dir: string): SkillInput[] {
  const allInputs: SkillInput[] = [];
  const seenInputs = new Set<string>();

  for (const skillFile of findSkillFiles(dir)) {
    try {
      const content = fs.readFileSync(skillFile, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      if (!frontmatter) continue;
      for (const input of extractInputs(frontmatter)) {
        if (!seenInputs.has(input.envVar)) {
          seenInputs.add(input.envVar);
          allInputs.push(input);
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return allInputs;
}

/**
 * Install skills from a GitHub repository using `npx skills add`.
 *
 * 1. Runs `npx skills add` in a temp directory (--copy so files are portable)
 * 2. Copies installed skills from temp .claude/skills/ into container/skills/
 * 3. Parses SKILL.md frontmatter for required inputs (env vars)
 * 4. Updates persistent lock file so skills are re-synced on restart
 */
export async function installSkillsFromRepo(
  repo: string,
): Promise<InstallSkillsResult> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pepper-skill-'));
  const skillsDir = path.join(process.cwd(), 'container', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  try {
    const hasGhToken = !!(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
    logger.info({ repo, hasGhToken }, 'Installing skills via npx skills add');

    // Build env: forward GITHUB_TOKEN so npx skills add can clone private repos
    const childEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      DO_NOT_TRACK: '1',
      CI: 'true',
      NO_COLOR: '1',
      TERM: 'dumb',
    };
    // Configure git to use token-based auth for private GitHub repos
    const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (ghToken) {
      childEnv.GIT_ASKPASS = 'echo';
      childEnv.GIT_TERMINAL_PROMPT = '0';
      // git uses this header for HTTPS auth — works for private repos without SSH keys
      childEnv.GIT_CONFIG_COUNT = '1';
      childEnv.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
      childEnv.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${ghToken}`).toString('base64')}`;
    }

    execSync(`npx -y skills add ${repo} --all --copy --agent claude-code --yes`, {
      cwd: tmpDir,
      stdio: 'pipe',
      timeout: 120_000,
      env: childEnv,
    });

    // npx skills add installs to {cwd}/.claude/skills/ for claude-code
    const installedDir = path.join(tmpDir, '.claude', 'skills');
    if (!fs.existsSync(installedDir)) {
      return {
        installed: [],
        requiredInputs: [],
        error: 'npx skills add produced no output in .claude/skills/',
      };
    }

    // Copy each installed skill directory into container/skills/
    const installed: string[] = [];
    for (const entry of fs.readdirSync(installedDir)) {
      const srcDir = path.join(installedDir, entry);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const destDir = path.join(skillsDir, entry);
      fs.cpSync(srcDir, destDir, { recursive: true });
      installed.push(entry);
      logger.info({ skill: entry }, 'Installed skill');
    }

    if (installed.length === 0) {
      return {
        installed: [],
        requiredInputs: [],
        error: 'No skills found after npx skills add',
      };
    }

    // Parse frontmatter from installed skills to discover required inputs
    // (npx skills doesn't handle the `inputs` field — that's our extension)
    const requiredInputs = collectInputsFromDir(skillsDir);

    // Update persistent lock file (survives Railway deploys)
    const lock = readLockFile();
    const repoShort = repo
      .replace(/^https:\/\/github\.com\//, '')
      .replace(/\.git$/, '');
    lock.skills[repoShort] = {
      source: repoShort,
      sourceType: 'github',
    };
    writeLockFile(lock);

    return { installed, requiredInputs };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const stderr =
      err instanceof Error && 'stderr' in err
        ? Buffer.isBuffer((err as { stderr?: unknown }).stderr)
          ? (err as { stderr: Buffer }).stderr.toString('utf-8')
          : String((err as { stderr?: unknown }).stderr || '')
        : '';
    const stdout =
      err instanceof Error && 'stdout' in err
        ? Buffer.isBuffer((err as { stdout?: unknown }).stdout)
          ? (err as { stdout: Buffer }).stdout.toString('utf-8')
          : String((err as { stdout?: unknown }).stdout || '')
        : '';
    logger.error(
      {
        repo,
        errorMsg,
        stderr: stderr.slice(0, 2000),
        stdout: stdout.slice(0, 2000),
      },
      'Failed to install skills from repo',
    );
    return { installed: [], requiredInputs: [], error: errorMsg };
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
}

/**
 * Remove a skill by name. Deletes the skill directory and removes from lock file.
 */
export function removeSkill(name: string): {
  removed: boolean;
  error?: string;
} {
  const skillsDir = path.join(process.cwd(), 'container', 'skills');
  const skillDir = path.join(skillsDir, name);

  // Remove the skill directory
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true, force: true });
    logger.info({ skill: name }, 'Removed skill directory');
  }

  // Remove from lock file (match by skill name appearing in any repo entry)
  const lock = readLockFile();
  let removed = false;
  for (const [key, entry] of Object.entries(lock.skills)) {
    // The skill name might be the repo key or a subdirectory installed from it
    if (key === name || key.endsWith(`/${name}`)) {
      delete lock.skills[key];
      removed = true;
    }
  }
  if (removed) {
    writeLockFile(lock);
  }

  return { removed: removed || fs.existsSync(skillDir) === false };
}

/**
 * List all installed skills from the lock file and skills directory.
 */
export function listSkills(): {
  skills: Array<{ name: string; source: string; sourceType: string }>;
} {
  const lock = readLockFile();
  const skillsDir = path.join(process.cwd(), 'container', 'skills');

  // Include skills from lock file
  const skills = Object.entries(lock.skills).map(([key, entry]) => ({
    name: key,
    source: entry.source,
    sourceType: entry.sourceType,
  }));

  // Also include any skill directories not in lock file (manually added)
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir)) {
      if (entry.startsWith('.')) continue;
      const fullPath = path.join(skillsDir, entry);
      if (!fs.statSync(fullPath).isDirectory()) continue;
      if (!skills.some((s) => s.name === entry)) {
        skills.push({ name: entry, source: 'local', sourceType: 'local' });
      }
    }
  }

  return { skills };
}

/**
 * Sync all skills from the lock file on startup.
 * Re-installs each registered repo via `npx skills add` so skills
 * survive Railway deploys and stay up-to-date with their source repos.
 */
export async function syncSkillsOnStartup(): Promise<void> {
  const lock = readLockFile();
  const repos = Object.values(lock.skills);

  if (repos.length === 0) {
    logger.debug('No skills registered in lock file, skipping sync');
    return;
  }

  logger.info({ repoCount: repos.length }, 'Syncing skills from lock file');

  for (const entry of repos) {
    if (entry.sourceType !== 'github') continue;
    try {
      const result = await installSkillsFromRepo(entry.source);
      if (result.error) {
        logger.error(
          { repo: entry.source, error: result.error },
          'Failed to sync skill repo on startup',
        );
      } else {
        logger.info(
          { repo: entry.source, installed: result.installed },
          'Skill repo synced on startup',
        );
      }
    } catch (err) {
      logger.error(
        { repo: entry.source, err },
        'Error syncing skill repo on startup',
      );
    }
  }
}

/**
 * Collect env var names required by installed skills (from SKILL.md frontmatter inputs).
 */
export function collectSkillEnvVars(): string[] {
  const skillsDir = path.join(process.cwd(), 'container', 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  return collectInputsFromDir(skillsDir).map((input) => input.envVar);
}

/**
 * Fetch the skills.sh page for a URL and extract the npx install command from its HTML.
 * skills.sh pages embed the canonical install command — using it avoids guessing
 * GitHub paths and handles skills spread across non-standard directory layouts.
 *
 * Returns { githubUrl, skillFlag } or null if extraction fails.
 */
async function resolveSkillsShCommand(
  url: string,
): Promise<{ githubUrl: string; skillFlag: string | null } | null> {
  if (!url.match(/^https?:\/\/skills\.sh\//)) return null;

  let pageText: string;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'pepper-skill-installer' } });
    if (!res.ok) return null;
    pageText = await res.text();
  } catch {
    return null;
  }

  // Match: npx skills add https://github.com/owner/repo [--skill name] [optional flags]
  const match = pageText.match(/npx skills add (https:\/\/github\.com\/[^\s"'<]+?)(?:\s+--skill\s+([^\s"'<]+))?(?:\s|"|'|<|$)/);
  if (!match) return null;

  return {
    githubUrl: match[1],
    skillFlag: match[2] ?? null,
  };
}

/**
 * Install a skill from a skills.sh URL by fetching the page to get the canonical
 * npx command, then running it. This is the authoritative install path — skills.sh
 * pages embed the exact command so we never have to guess GitHub directory layouts.
 *
 * Returns the installed skill name(s), or null if the URL is not a skills.sh URL.
 */
/**
 * Install a skill from agentskills.io — Pepper's own skill registry.
 * URL format: https://agentskills.io/<skill-name>
 *
 * Downloads the full skill directory (SKILL.md + all scripts/assets) from
 * marmikcfc/pepper-skills using PEPPER_GITHUB_TOKEN (platform token, never
 * the user's GITHUB_TOKEN). Returns the installed skill name, or null if
 * the URL is not an agentskills.io URL.
 */
async function fetchAgentSkillsIo(
  url: string,
  skillsDir: string,
): Promise<string | null> {
  if (!url.match(/^https?:\/\/agentskills\.io\//)) return null;

  const skillName = url.split('/').filter(Boolean).pop();
  if (!skillName) return null;

  const owner = 'marmikcfc';
  const repo = 'pepper-skills';
  const dirPath = `skills/${skillName}`;

  // Use Pepper's platform token — never the user's GITHUB_TOKEN
  const token = process.env.PEPPER_GITHUB_TOKEN;
  const headers: Record<string, string> = { 'User-Agent': 'pepper-skill-installer' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const listUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}`;
  let files: Array<{ name: string; type: string; download_url: string | null }>;
  try {
    const res = await fetch(listUrl, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    files = await res.json() as Array<{ name: string; type: string; download_url: string | null }>;
  } catch (err) {
    throw new Error(`Failed to list ${dirPath} in ${owner}/${repo}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const destDir = path.join(skillsDir, skillName);
  fs.mkdirSync(destDir, { recursive: true });

  const downloaded: string[] = [];
  for (const file of files) {
    if (file.type !== 'file' || !file.download_url) continue;
    const fileRes = await fetch(file.download_url, { headers });
    if (!fileRes.ok) {
      logger.warn({ file: file.name, skillName }, 'Failed to download skill file, skipping');
      continue;
    }
    fs.writeFileSync(path.join(destDir, file.name), await fileRes.text());
    downloaded.push(file.name);
  }

  if (!downloaded.includes('SKILL.md')) {
    throw new Error(`SKILL.md not found in ${owner}/${repo}/${dirPath}`);
  }

  logger.info({ skill: skillName, url, files: downloaded }, 'Installed skill from agentskills.io');
  return skillName;
}

/**
 * Install a skill from a raw GitHub SKILL.md URL.
 * URL format: https://raw.githubusercontent.com/<owner>/<repo>/main/<path>/SKILL.md
 * The skill name is derived from the parent directory of SKILL.md in the path.
 * Returns the installed skill name, or null if the URL is not a raw GitHub SKILL.md URL.
 */
async function fetchRawSkillMd(
  url: string,
  skillsDir: string,
): Promise<string | null> {
  if (!url.match(/^https?:\/\/raw\.githubusercontent\.com\//)) return null;
  if (!url.endsWith('/SKILL.md')) return null;

  // Derive skill name from the parent directory in the path
  // e.g. .../main/skills/copywriting/SKILL.md → "copywriting"
  const parts = url.split('/');
  const skillName = parts[parts.length - 2];
  if (!skillName) return null;

  let content: string;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'pepper-skill-installer' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    content = await res.text();
  } catch (err) {
    throw new Error(`Failed to download SKILL.md from ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const destDir = path.join(skillsDir, skillName);
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'SKILL.md'), content);

  logger.info({ skill: skillName, url }, 'Installed skill from raw GitHub SKILL.md URL');
  return skillName;
}

async function fetchSkillDirect(
  url: string,
  skillsDir: string,
): Promise<string | null> {
  // Branch 0: agentskills.io — Pepper's registry, full directory download
  const agentSkillsResult = await fetchAgentSkillsIo(url, skillsDir);
  if (agentSkillsResult !== null) return agentSkillsResult;

  // Branch 1: raw GitHub SKILL.md direct download (single file only)
  const rawResult = await fetchRawSkillMd(url, skillsDir);
  if (rawResult !== null) return rawResult;

  // Branch 2: skills.sh page scraping → npx skills add (uses user's GITHUB_TOKEN)
  if (!url.match(/^https?:\/\/skills\.sh\//)) return null;

  const resolved = await resolveSkillsShCommand(url);
  if (!resolved) {
    throw new Error(`Could not extract npx command from skills.sh page: ${url}`);
  }

  const { githubUrl, skillFlag } = resolved;
  const skillArg = skillFlag ? `--skill ${skillFlag}` : '--all';
  const cmd = `npx -y skills add ${githubUrl} ${skillArg} --copy --agent claude-code --yes`;

  logger.info({ url, githubUrl, skillFlag, cmd }, 'Installing skill via skills.sh resolved command');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pepper-ext-skill-'));
  try {
    const childEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      DO_NOT_TRACK: '1',
      CI: 'true',
      NO_COLOR: '1',
      TERM: 'dumb',
    };
    const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (ghToken) {
      childEnv.GIT_ASKPASS = 'echo';
      childEnv.GIT_TERMINAL_PROMPT = '0';
      childEnv.GIT_CONFIG_COUNT = '1';
      childEnv.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
      childEnv.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${ghToken}`).toString('base64')}`;
    }

    execSync(cmd, { cwd: tmpDir, stdio: 'pipe', timeout: 120_000, env: childEnv });

    const installedDir = path.join(tmpDir, '.claude', 'skills');
    if (!fs.existsSync(installedDir)) {
      throw new Error('npx skills add produced no output in .claude/skills/');
    }

    let installed: string | null = null;
    for (const entry of fs.readdirSync(installedDir)) {
      const srcDir = path.join(installedDir, entry);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const destDir = path.join(skillsDir, entry);
      fs.cpSync(srcDir, destDir, { recursive: true });
      installed = entry;
      logger.info({ skill: entry, url }, 'Installed external skill via skills.sh');
    }

    return installed;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Install external skills from EXTERNAL_SKILLS env var.
 * Format: comma-separated skills.sh URLs (or any source the skills CLI accepts).
 * Example: "https://skills.sh/anthropics/knowledge-work-plugins/sales/skills/call-prep,https://skills.sh/coreyhaines31/marketingskills/free-tool-strategy"
 *
 * Primary: for skills.sh URLs, fetches the page to get the canonical npx command and runs it.
 * Fallback: runs npx skills add directly for bare GitHub URLs and other formats.
 */
export async function syncExternalSkills(): Promise<void> {
  const externalSkills = process.env.EXTERNAL_SKILLS;
  if (!externalSkills) {
    logger.debug('No EXTERNAL_SKILLS env var, skipping external skill sync');
    return;
  }

  const urls = externalSkills.split(',').map(e => e.trim()).filter(Boolean);
  if (urls.length === 0) return;

  logger.info({ count: urls.length }, 'Syncing external skills from EXTERNAL_SKILLS env var');

  const skillsDir = path.join(process.cwd(), 'container', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  for (const url of urls) {
    try {
      // Primary: direct fetch from GitHub (bypasses npx + skills CLI)
      const skillName = await fetchSkillDirect(url, skillsDir);
      if (skillName) {
        logger.info({ skill: skillName, url }, 'Installed external skill via skills.sh resolution');
        continue;
      }

      // Fallback: npx skills add for non-skills.sh URLs
      logger.info({ url }, 'Installing external skill via npx');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pepper-ext-skill-'));

      const childEnv: Record<string, string> = {
        ...(process.env as Record<string, string>),
        DO_NOT_TRACK: '1',
        CI: 'true',
        NO_COLOR: '1',
        TERM: 'dumb',
      };
      const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (ghToken) {
        childEnv.GIT_ASKPASS = 'echo';
        childEnv.GIT_TERMINAL_PROMPT = '0';
        childEnv.GIT_CONFIG_COUNT = '1';
        childEnv.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
        childEnv.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${ghToken}`).toString('base64')}`;
      }

      execSync(
        `npx -y skills add ${url} --copy --agent claude-code --yes`,
        { cwd: tmpDir, stdio: 'pipe', timeout: 120_000, env: childEnv },
      );

      // Copy installed skill to container/skills/
      const installedDir = path.join(tmpDir, '.claude', 'skills');
      if (fs.existsSync(installedDir)) {
        for (const name of fs.readdirSync(installedDir)) {
          const srcDir = path.join(installedDir, name);
          if (!fs.statSync(srcDir).isDirectory()) continue;
          const destDir = path.join(skillsDir, name);
          fs.cpSync(srcDir, destDir, { recursive: true });
          logger.info({ skill: name, url }, 'Installed external skill via npx');
        }
      }

      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const stderr = err instanceof Error && 'stderr' in err
        ? Buffer.isBuffer((err as { stderr?: unknown }).stderr)
          ? (err as { stderr: Buffer }).stderr.toString('utf-8')
          : String((err as { stderr?: unknown }).stderr || '')
        : '';
      const stdout = err instanceof Error && 'stdout' in err
        ? Buffer.isBuffer((err as { stdout?: unknown }).stdout)
          ? (err as { stdout: Buffer }).stdout.toString('utf-8')
          : String((err as { stdout?: unknown }).stdout || '')
        : '';
      logger.error(
        `Failed to install external skill: url=${url} | ${errorMsg}${stderr ? ` | stderr: ${stderr.slice(0, 500)}` : ''}${stdout ? ` | stdout: ${stdout.slice(0, 500)}` : ''}`,
      );
    }
  }
}
