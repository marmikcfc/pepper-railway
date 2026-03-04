import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpServersLock {
  version: number;
  servers: Record<string, McpServerEntry>;
}

/**
 * Persistent path for mcp-servers.json.
 * Lives in DATA_DIR (Railway persistent volume or local data/) so it survives deploys.
 */
function lockFilePath(): string {
  return path.join(DATA_DIR, 'mcp-servers.json');
}

function readLockFile(): McpServersLock {
  const lockPath = lockFilePath();
  if (fs.existsSync(lockPath)) {
    try {
      return JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    } catch {
      // Corrupt, start fresh
    }
  }
  return { version: 1, servers: {} };
}

function writeLockFile(lock: McpServersLock): void {
  const lockPath = lockFilePath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

/**
 * Register a new MCP server in the persistent lock file.
 */
export function addMcpServer(
  name: string,
  config: { command: string; args: string[]; env?: Record<string, string> },
): { added: boolean; envVarsNeeded: string[] } {
  const lock = readLockFile();
  lock.servers[name] = {
    command: config.command,
    args: config.args,
    env: config.env,
  };
  writeLockFile(lock);
  logger.info({ name }, 'MCP server registered');

  // Extract ${VAR} references from env values
  const envVarsNeeded: string[] = [];
  for (const val of Object.values(config.env || {})) {
    const match = val.match(/^\$\{(.+)\}$/);
    if (match && !envVarsNeeded.includes(match[1])) {
      envVarsNeeded.push(match[1]);
    }
  }

  return { added: true, envVarsNeeded };
}

/**
 * Remove an MCP server from the persistent lock file.
 */
export function removeMcpServer(name: string): { removed: boolean } {
  const lock = readLockFile();
  if (name in lock.servers) {
    delete lock.servers[name];
    writeLockFile(lock);
    logger.info({ name }, 'MCP server removed');
    return { removed: true };
  }
  return { removed: false };
}

/**
 * List all registered MCP servers from the lock file.
 */
export function listMcpServers(): {
  servers: Array<{ name: string; command: string; args: string[]; env?: Record<string, string> }>;
} {
  const lock = readLockFile();
  return {
    servers: Object.entries(lock.servers).map(([name, entry]) => ({
      name,
      ...entry,
    })),
  };
}

/**
 * Rebuild the project .mcp.json by merging the project root's base config
 * with persistent lock file entries.
 */
export function rebuildMcpJson(): void {
  const mcpJsonPath = path.join(process.cwd(), '.mcp.json');

  // Read existing base config (may not exist)
  let baseConfig: { mcpServers?: Record<string, McpServerEntry> } = {};
  const baseConfigPath = path.join(DATA_DIR, 'mcp-base.json');
  if (fs.existsSync(baseConfigPath)) {
    try {
      baseConfig = JSON.parse(fs.readFileSync(baseConfigPath, 'utf-8'));
    } catch {
      // Corrupt base, start fresh
    }
  } else if (fs.existsSync(mcpJsonPath)) {
    // First time: save current .mcp.json as base
    try {
      baseConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
      fs.mkdirSync(path.dirname(baseConfigPath), { recursive: true });
      fs.writeFileSync(baseConfigPath, JSON.stringify(baseConfig, null, 2) + '\n');
    } catch {
      // Ignore
    }
  }

  // Merge base + persistent lock entries
  const lock = readLockFile();
  const merged = {
    mcpServers: {
      ...(baseConfig.mcpServers || {}),
      ...lock.servers,
    },
  };

  fs.writeFileSync(mcpJsonPath, JSON.stringify(merged, null, 2) + '\n');
  logger.info(
    { serverCount: Object.keys(merged.mcpServers).length },
    'Rebuilt .mcp.json',
  );
}

/**
 * Sync MCP servers on startup — rebuild .mcp.json from persistent lock file.
 */
export async function syncMcpOnStartup(): Promise<void> {
  const lock = readLockFile();
  if (Object.keys(lock.servers).length === 0) {
    logger.debug('No persistent MCP servers registered, skipping sync');
    return;
  }

  logger.info(
    { serverCount: Object.keys(lock.servers).length },
    'Syncing MCP servers from lock file',
  );
  rebuildMcpJson();
}

/**
 * Collect env var names referenced in persistent MCP server configs (${VAR} syntax).
 * Used by readSecrets() to forward these credentials to containers.
 */
export function collectPersistentMcpEnvVars(): string[] {
  const lock = readLockFile();
  const envVars: string[] = [];
  for (const server of Object.values(lock.servers)) {
    for (const val of Object.values(server.env || {})) {
      const match = val.match(/^\$\{(.+)\}$/);
      if (match && !envVars.includes(match[1])) {
        envVars.push(match[1]);
      }
    }
  }
  return envVars;
}
