// Storage abstraction: Vercel Blob in production, filesystem locally
// Auto-detects based on BLOB_READ_WRITE_TOKEN presence

import { writeFile, readFile, mkdir } from 'fs/promises';
import { join } from 'path';

const USE_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;

// Lazy import @vercel/blob only when needed (avoids crashes locally)
async function getBlobSdk() {
  const blob = await import('@vercel/blob');
  return blob;
}

export interface StorageResult {
  url: string;
}

/** Upload a file (binary or string) to storage */
export async function storagePut(
  path: string,
  body: File | Blob | string | Buffer,
  options?: { contentType?: string }
): Promise<StorageResult> {
  if (USE_BLOB) {
    const { put } = await getBlobSdk();
    const blob = await put(path, body, {
      access: 'public',
      addRandomSuffix: false,
      ...(options?.contentType ? { contentType: options.contentType } : {}),
    });
    return { url: blob.url };
  }

  // Local filesystem storage
  const localDir = join(process.cwd(), 'data');
  const filePath = join(localDir, path);
  const dir = filePath.substring(0, filePath.lastIndexOf('\\') > -1 ? filePath.lastIndexOf('\\') : filePath.lastIndexOf('/'));
  await mkdir(dir, { recursive: true });

  let buffer: Buffer;
  if (typeof body === 'string') {
    buffer = Buffer.from(body, 'utf-8');
  } else if (body instanceof Buffer) {
    buffer = body;
  } else {
    // File or Blob
    buffer = Buffer.from(await (body as Blob).arrayBuffer());
  }

  await writeFile(filePath, buffer);

  // Return a local URL served by our API routes
  const origin = process.env.NEXT_PUBLIC_URL || 'http://localhost:3000';
  return { url: `${origin}/api/local-blob/${path}` };
}

/** List blobs by prefix and return the first match's content as text */
export async function storageGetJson(prefix: string): Promise<unknown | null> {
  if (USE_BLOB) {
    const { list } = await getBlobSdk();
    const { blobs } = await list({ prefix });
    if (blobs.length === 0) return null;
    const response = await fetch(blobs[0].url);
    if (!response.ok) return null;
    return response.json();
  }

  // Local filesystem
  const filePath = join(process.cwd(), 'data', prefix);
  try {
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** Get a redirect URL for a stored file */
export async function storageGetFileUrl(prefix: string): Promise<string | null> {
  if (USE_BLOB) {
    const { list } = await getBlobSdk();
    const { blobs } = await list({ prefix });
    if (blobs.length === 0) return null;
    return blobs[0].url;
  }

  // Local: return the API proxy URL
  const filePath = join(process.cwd(), 'data', prefix);
  try {
    await readFile(filePath); // Check existence
    const origin = process.env.NEXT_PUBLIC_URL || 'http://localhost:3000';
    return `${origin}/api/local-blob/${prefix}`;
  } catch {
    return null;
  }
}
