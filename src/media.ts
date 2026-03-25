/**
 * Shared media processing utilities for multimodal agent input.
 * All channels route their downloaded media through these helpers before
 * storing it as a ProcessedAttachment on the message.
 */
import sharp from 'sharp';
import { logger } from './logger.js';

export interface ProcessedAttachment {
  /** 'image' → Claude image content block; 'document' → Claude document block (PDFs) */
  type: 'image' | 'document';
  mimeType: string;
  base64: string;
  filename?: string;
}

/** Maximum longest-edge dimension for images passed to Claude. */
const MAX_IMAGE_PX = 1568;

/**
 * Resize an image to fit within MAX_IMAGE_PX on the longest edge, convert to
 * JPEG for consistent encoding, and base64-encode the result.
 * Throws on failure — callers should catch and fall back to placeholder text.
 */
export async function processImage(
  buffer: Buffer,
  _mimeType: string,
  filename?: string,
): Promise<ProcessedAttachment> {
  const resized = await sharp(buffer)
    .resize(MAX_IMAGE_PX, MAX_IMAGE_PX, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  return {
    type: 'image',
    mimeType: 'image/jpeg',
    base64: resized.toString('base64'),
    filename,
  };
}

/**
 * Base64-encode a PDF buffer for Claude's native document support.
 * Claude supports PDFs up to 100 pages / 32 MB.
 * Throws on failure — callers should catch and fall back to placeholder text.
 */
export function processPdf(buffer: Buffer, filename?: string): ProcessedAttachment {
  if (buffer.length > 32 * 1024 * 1024) {
    throw new Error(`PDF too large: ${buffer.length} bytes (max 32 MB)`);
  }
  return {
    type: 'document',
    mimeType: 'application/pdf',
    base64: buffer.toString('base64'),
    filename,
  };
}

/**
 * Download bytes from an HTTP/HTTPS URL.
 * Optional headers (e.g. Authorization for Telegram) can be passed.
 * Throws on non-2xx response or network error.
 */
export async function downloadBuffer(
  url: string,
  headers?: Record<string, string>,
): Promise<Buffer> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText} — ${url}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Detect media type from MIME string and process appropriately.
 * Returns null (with a warning log) if the type is unsupported.
 */
export async function processAttachment(
  buffer: Buffer,
  mimeType: string,
  filename?: string,
): Promise<ProcessedAttachment | null> {
  if (mimeType.startsWith('image/')) {
    return processImage(buffer, mimeType, filename);
  }
  if (mimeType === 'application/pdf') {
    return processPdf(buffer, filename);
  }
  logger.warn({ mimeType, filename }, 'media: unsupported attachment type, skipping');
  return null;
}
