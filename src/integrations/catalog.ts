// nanoclaw-railway/src/integrations/catalog.ts
export interface Integration {
  id: string;
  envVars: Record<string, string>;
  implementation: {
    cli?: { bin: string };
    mcp?: { package: string; command: string; args: string[] };
  };
  webhook?: {
    signatureHeader: string;
    signatureEnvVar: string;
  };
}

export const INTEGRATIONS: Integration[] = [
  {
    id: 'github',
    envVars: { token: 'GH_TOKEN' },
    implementation: { cli: { bin: 'gh' } },
    webhook: { signatureHeader: 'X-Hub-Signature-256', signatureEnvVar: 'GITHUB_WEBHOOK_SECRET' },
  },
  {
    id: 'supabase',
    envVars: { url: 'SUPABASE_URL', serviceKey: 'SUPABASE_SERVICE_KEY', accessToken: 'SUPABASE_ACCESS_TOKEN' },
    implementation: { cli: { bin: 'supabase' } },
  },
  {
    id: 'aws-s3',
    envVars: { accessKeyId: 'AWS_ACCESS_KEY_ID', secretAccessKey: 'AWS_SECRET_ACCESS_KEY', region: 'AWS_DEFAULT_REGION' },
    implementation: { cli: { bin: 'aws' } },
  },
  {
    id: 'google-drive',
    envVars: { credentials: 'GOOGLE_CREDENTIALS' },
    implementation: { mcp: { package: 'mcp-server-gdrive', command: 'mcp-server-gdrive', args: [] } },
  },
  {
    id: 'agentmail',
    envVars: { apiKey: 'AGENTMAIL_API_KEY' },
    implementation: { mcp: { package: '@agentmail/mcp', command: 'agentmail-mcp', args: [] } },
    webhook: { signatureHeader: 'X-AgentMail-Signature', signatureEnvVar: 'AGENTMAIL_WEBHOOK_SECRET' },
  },
  {
    id: 'figma',
    envVars: { accessToken: 'FIGMA_ACCESS_TOKEN' },
    implementation: { mcp: { package: 'mcp-server-figma', command: 'mcp-server-figma', args: [] } },
  },
];

export function getIntegration(id: string): Integration | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}
