import { randomBytes } from 'node:crypto';

// Simple ULID-like ID: timestamp prefix + random suffix (sortable, unique)
export function ulid(): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = randomBytes(8).toString('hex');
  return `${ts}-${rand}`;
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function nowISO(): string {
  return new Date().toISOString();
}
