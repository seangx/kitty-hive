/**
 * File storage helpers. Files live at ~/.kitty-hive/files/<file_id>/<filename>.
 * Used for both DM/task attachments and federation transfers.
 */

import { mkdirSync, copyFileSync, writeFileSync, statSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { ulid } from './utils.js';
import type { FileAttachment } from './models.js';

const FILES_ROOT = join(homedir(), '.kitty-hive', 'files');

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

export function inferMime(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] || 'application/octet-stream';
}

function newFileId(): string {
  return 'f_' + ulid().slice(-12);
}

function ensureRoot(): void {
  mkdirSync(FILES_ROOT, { recursive: true });
}

export function getFilePath(fileId: string): string | null {
  const dir = join(FILES_ROOT, fileId);
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir);
  if (entries.length === 0) return null;
  return join(dir, entries[0]);
}

export function getFileMeta(fileId: string): FileAttachment | null {
  const path = getFilePath(fileId);
  if (!path) return null;
  const filename = basename(path);
  return {
    file_id: fileId,
    filename,
    mime: inferMime(filename),
    size: statSync(path).size,
  };
}

// Store an existing local file as a hive-managed attachment. Copies (does not move).
export function storeFileFromPath(localPath: string): FileAttachment {
  if (!existsSync(localPath)) throw new Error(`File not found: ${localPath}`);
  const filename = basename(localPath);
  const fileId = newFileId();
  const dir = join(FILES_ROOT, fileId);
  mkdirSync(dir, { recursive: true });
  copyFileSync(localPath, join(dir, filename));
  ensureRoot();
  return {
    file_id: fileId,
    filename,
    mime: inferMime(filename),
    size: statSync(localPath).size,
  };
}

// Store raw binary as a hive-managed attachment (used by federation receive endpoint).
export function storeFileFromBuffer(filename: string, data: Buffer): FileAttachment {
  const fileId = newFileId();
  const dir = join(FILES_ROOT, fileId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), data);
  return {
    file_id: fileId,
    filename,
    mime: inferMime(filename),
    size: data.length,
  };
}

// Read the binary contents of a stored file. Used when forwarding to a peer.
export function readFileBinary(fileId: string): { data: Buffer; filename: string; mime: string } | null {
  const path = getFilePath(fileId);
  if (!path) return null;
  const filename = basename(path);
  return {
    data: readFileSync(path),
    filename,
    mime: inferMime(filename),
  };
}
