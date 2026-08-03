import assert from 'node:assert/strict';
import test from 'node:test';
import { DisconnectedSessionReaper } from './session-lifecycle.js';

class FakeClock {
  private nextId = 1;
  private readonly callbacks = new Map<number, () => void>();

  setTimeout(callback: () => void): number {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  runAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }

  get pendingCount(): number {
    return this.callbacks.size;
  }
}

test('reaps a session whose SSE stream does not reconnect', () => {
  const activeSSE = new Set<string>();
  const expired: string[] = [];
  const clock = new FakeClock();
  const reaper = new DisconnectedSessionReaper(activeSSE, sid => expired.push(sid), 30_000, undefined, clock);

  const stream = reaper.openStream('session-1');
  reaper.closeStream('session-1', stream);

  assert.equal(activeSSE.has('session-1'), false);
  assert.equal(clock.pendingCount, 1);
  clock.runAll();
  assert.deepEqual(expired, ['session-1']);
});

test('a reconnected SSE stream cancels pending cleanup', () => {
  const activeSSE = new Set<string>();
  const expired: string[] = [];
  const clock = new FakeClock();
  const reaper = new DisconnectedSessionReaper(activeSSE, sid => expired.push(sid), 30_000, undefined, clock);

  const oldStream = reaper.openStream('session-1');
  reaper.closeStream('session-1', oldStream);
  reaper.openStream('session-1');
  clock.runAll();

  assert.equal(activeSSE.has('session-1'), true);
  assert.equal(clock.pendingCount, 0);
  assert.deepEqual(expired, []);
});

test('an in-flight request defers cleanup until the request ends', () => {
  const activeSSE = new Set<string>();
  const expired: string[] = [];
  const clock = new FakeClock();
  const reaper = new DisconnectedSessionReaper(activeSSE, sid => expired.push(sid), 30_000, undefined, clock);

  const stream = reaper.openStream('session-1');
  reaper.closeStream('session-1', stream);
  const request = reaper.beginRequest('session-1');

  assert.equal(clock.pendingCount, 0);
  clock.runAll();
  assert.deepEqual(expired, []);

  reaper.endRequest('session-1', request);
  assert.equal(clock.pendingCount, 1);
  clock.runAll();
  assert.deepEqual(expired, ['session-1']);
});

test('closing an older stream cannot retire a replacement stream', () => {
  const activeSSE = new Set<string>();
  const expired: string[] = [];
  const clock = new FakeClock();
  const reaper = new DisconnectedSessionReaper(activeSSE, sid => expired.push(sid), 30_000, undefined, clock);

  const oldStream = reaper.openStream('session-1');
  const replacementStream = reaper.openStream('session-1');
  reaper.closeStream('session-1', oldStream);
  clock.runAll();

  assert.equal(activeSSE.has('session-1'), true);
  assert.equal(clock.pendingCount, 0);
  assert.deepEqual(expired, []);

  reaper.closeStream('session-1', replacementStream);
  clock.runAll();
  assert.deepEqual(expired, ['session-1']);
});
