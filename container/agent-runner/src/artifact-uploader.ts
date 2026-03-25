/**
 * Artifact uploader — presign → PUT → confirm pipeline.
 * Called by the upload_artifact MCP tool in ipc-mcp-stdio.ts.
 */
import { createHmac } from 'crypto';
import fs from 'fs';
import path from 'path';

interface PresignResponse {
  artifact_id: string;
  upload_url: string;
  storage_path: string;
}

interface ConfirmResponse {
  storage_path: string;
  ephemeral_url: string;
}

export interface ArtifactResult {
  artifact_id: string;
  ephemeral_url: string;
}

function hmacSign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

async function cloudPost<T>(
  cloudUrl: string,
  secret: string,
  tenantId: string,
  path: string,
  body: object,
): Promise<T> {
  const bodyText = JSON.stringify(body);
  const sig = hmacSign(secret, bodyText);
  const resp = await fetch(`${cloudUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Event-Signature': sig,
    },
    body: bodyText,
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`${resp.status} ${resp.statusText}: ${text}`);
  }
  return resp.json() as Promise<T>;
}

export async function uploadArtifact(opts: {
  filePath: string;
  title?: string;
  mimeType?: string;
  cloudUrl: string;
  eventSecret: string;
  tenantId: string;
  taskId?: string;
}): Promise<ArtifactResult> {
  const { filePath, title, cloudUrl, eventSecret, tenantId, taskId } = opts;

  const filename = path.basename(filePath);
  const stat = fs.statSync(filePath);
  const sizeBytes = stat.size;

  // Detect MIME type from extension if not provided
  const mimeType = opts.mimeType ?? detectMimeType(filename);

  // Step 1: Request presigned PUT URL
  const presign = await cloudPost<PresignResponse>(
    cloudUrl,
    eventSecret,
    tenantId,
    `/api/artifacts/${tenantId}/presign`,
    {
      task_id: taskId,
      filename,
      title: title ?? filename,
      mime_type: mimeType,
      size_bytes: sizeBytes,
    },
  );

  // Step 2: PUT file directly to Supabase Storage
  const fileBuffer = fs.readFileSync(filePath);
  const putResp = await fetch(presign.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType },
    body: fileBuffer,
    signal: AbortSignal.timeout(120_000), // 2 min for large files
  });
  if (!putResp.ok) {
    const text = await putResp.text().catch(() => '');
    throw new Error(`Storage PUT failed ${putResp.status}: ${text}`);
  }

  // Step 3: Confirm upload
  const confirm = await cloudPost<ConfirmResponse>(
    cloudUrl,
    eventSecret,
    tenantId,
    `/api/artifacts/${tenantId}/confirm`,
    { artifact_id: presign.artifact_id },
  );

  return {
    artifact_id: presign.artifact_id,
    ephemeral_url: confirm.ephemeral_url,
  };
}

function detectMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    csv: 'text/csv',
    json: 'application/json',
    txt: 'text/plain',
    zip: 'application/zip',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return map[ext] ?? 'application/octet-stream';
}
