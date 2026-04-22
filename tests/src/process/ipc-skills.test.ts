import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/skill-installer.js', () => ({
  installSkillsFromRepo: vi.fn(),
  removeSkill: vi.fn(),
  listSkills: vi.fn(),
}));

import { IpcDeps, processTaskIpc, _resetCatalogCache } from '../../../src/ipc.js';
import {
  installSkillsFromRepo,
  listSkills,
  removeSkill,
} from '../../../src/skill-installer.js';

const mockInstall = vi.mocked(installSkillsFromRepo);
const mockRemove = vi.mocked(removeSkill);
const mockList = vi.mocked(listSkills);

let writeFileSyncSpy: ReturnType<typeof vi.spyOn>;
let restartAgentSpy: ReturnType<typeof vi.fn>;
let deps: IpcDeps;

beforeEach(() => {
  vi.clearAllMocks();
  _resetCatalogCache();

  writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
  vi.spyOn(fs, 'renameSync').mockImplementation(() => {});

  restartAgentSpy = vi.fn();

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => ({}),
    registerGroup: () => {},
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    restartAgent: restartAgentSpy,
  };

  // Default: catalog contains the test repo
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        platform: [],
        catalog: [
          {
            id: 'owner-repo',
            name: 'test-skill',
            source_url: 'https://skills.sh/owner/repo/test-skill',
          },
        ],
      }),
    }),
  );

  process.env.PEPPER_CLOUD_URL = 'http://localhost:3000';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// --- install_skills ---

describe('install_skills', () => {
  it('rejects when PEPPER_CLOUD_URL is not set', async () => {
    delete process.env.PEPPER_CLOUD_URL;

    await processTaskIpc(
      { type: 'install_skills', repo: 'owner/repo', requestId: 'req-1' },
      'main-group',
      deps,
    );

    expect(mockInstall).not.toHaveBeenCalled();
    expect(writeFileSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining('req-1.json.tmp'),
      expect.stringContaining('PEPPER_CLOUD_URL not configured'),
    );
    expect(restartAgentSpy).not.toHaveBeenCalled();
  });

  it('rejects when repo is not in catalog', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ platform: [], catalog: [] }),
      }),
    );

    await processTaskIpc(
      { type: 'install_skills', repo: 'owner/not-in-catalog', requestId: 'req-2' },
      'main-group',
      deps,
    );

    expect(mockInstall).not.toHaveBeenCalled();
    expect(writeFileSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining('req-2.json.tmp'),
      expect.stringContaining('not found in Pepper catalog'),
    );
    expect(restartAgentSpy).not.toHaveBeenCalled();
  });

  it('writes error response and skips restart when install fails', async () => {
    mockInstall.mockResolvedValue({
      installed: [],
      requiredInputs: [],
      error: 'npx failed: network error',
    });

    await processTaskIpc(
      { type: 'install_skills', repo: 'owner/repo', requestId: 'req-3' },
      'main-group',
      deps,
    );

    expect(mockInstall).toHaveBeenCalledWith('owner/repo');
    expect(writeFileSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining('req-3.json.tmp'),
      expect.stringContaining('npx failed'),
    );
    expect(restartAgentSpy).not.toHaveBeenCalled();
  });

  it('writes success response, skips restart when required inputs are present', async () => {
    mockInstall.mockResolvedValue({
      installed: ['test-skill'],
      requiredInputs: [{ name: 'API_KEY', description: 'key', envVar: 'API_KEY', required: true }],
    });

    await processTaskIpc(
      { type: 'install_skills', repo: 'owner/repo', requestId: 'req-4' },
      'main-group',
      deps,
    );

    expect(writeFileSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining('req-4.json.tmp'),
      expect.stringContaining('test-skill'),
    );
    expect(restartAgentSpy).not.toHaveBeenCalled();
  });

  it('writes success response and calls restartAgent when no required inputs', async () => {
    mockInstall.mockResolvedValue({
      installed: ['test-skill'],
      requiredInputs: [],
    });

    await processTaskIpc(
      { type: 'install_skills', repo: 'owner/repo', requestId: 'req-5' },
      'main-group',
      deps,
    );

    expect(writeFileSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining('req-5.json.tmp'),
      expect.stringContaining('test-skill'),
    );
    expect(restartAgentSpy).toHaveBeenCalledWith('main-group');
  });

  it('calls restartAgent when all inputs are optional (required: false)', async () => {
    mockInstall.mockResolvedValue({
      installed: ['test-skill'],
      requiredInputs: [
        { name: 'OPT_KEY', description: 'optional', envVar: 'OPT_KEY', required: false },
      ],
    });

    await processTaskIpc(
      { type: 'install_skills', repo: 'owner/repo', requestId: 'req-6' },
      'main-group',
      deps,
    );

    expect(restartAgentSpy).toHaveBeenCalledWith('main-group');
  });

  it('accepts full GitHub URL as repo', async () => {
    // Catalog skill source_url contains "owner/repo" — full URL normalizes to same
    mockInstall.mockResolvedValue({ installed: ['test-skill'], requiredInputs: [] });

    await processTaskIpc(
      {
        type: 'install_skills',
        repo: 'https://github.com/owner/repo',
        requestId: 'req-7',
      },
      'main-group',
      deps,
    );

    expect(mockInstall).toHaveBeenCalledWith('https://github.com/owner/repo');
    expect(restartAgentSpy).toHaveBeenCalledWith('main-group');
  });

  it('skips when repo is missing', async () => {
    await processTaskIpc(
      { type: 'install_skills', requestId: 'req-x' },
      'main-group',
      deps,
    );
    expect(mockInstall).not.toHaveBeenCalled();
  });
});

// --- remove_skill ---

describe('remove_skill', () => {
  it('calls removeSkill and writes response', async () => {
    mockRemove.mockReturnValue({ removed: true });

    await processTaskIpc(
      { type: 'remove_skill', name: 'test-skill', requestId: 'req-8' },
      'main-group',
      deps,
    );

    expect(mockRemove).toHaveBeenCalledWith('test-skill');
    expect(writeFileSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining('req-8.json.tmp'),
      expect.stringContaining('"removed":true'),
    );
    expect(restartAgentSpy).not.toHaveBeenCalled();
  });

  it('skips when name is missing', async () => {
    await processTaskIpc(
      { type: 'remove_skill', requestId: 'req-9' },
      'main-group',
      deps,
    );
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('skips when requestId is missing', async () => {
    await processTaskIpc(
      { type: 'remove_skill', name: 'test-skill' },
      'main-group',
      deps,
    );
    expect(mockRemove).not.toHaveBeenCalled();
  });
});

// --- list_skills ---

describe('list_skills', () => {
  it('calls listSkills and writes response', async () => {
    mockList.mockReturnValue({
      skills: [{ name: 'test-skill', source: 'owner/repo', sourceType: 'github' }],
    });

    await processTaskIpc(
      { type: 'list_skills', requestId: 'req-10' },
      'main-group',
      deps,
    );

    expect(mockList).toHaveBeenCalled();
    expect(writeFileSyncSpy).toHaveBeenCalledWith(
      expect.stringContaining('req-10.json.tmp'),
      expect.stringContaining('test-skill'),
    );
    expect(restartAgentSpy).not.toHaveBeenCalled();
  });

  it('skips when requestId is missing', async () => {
    await processTaskIpc(
      { type: 'list_skills' },
      'main-group',
      deps,
    );
    expect(mockList).not.toHaveBeenCalled();
  });
});
