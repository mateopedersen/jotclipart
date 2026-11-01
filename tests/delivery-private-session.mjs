import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { stopPrivateSession } from '../scripts/delivery/private-session.mjs';

class FakeChild extends EventEmitter {
  constructor(killHandler = () => true) {
    super();
    this.pid = 12345;
    this.exitCode = null;
    this.signalCode = null;
    this.signals = [];
    this.killHandler = killHandler;
  }
  kill(signal) {
    this.signals.push(signal);
    return this.killHandler.call(this, signal);
  }
  exitBySignal(signal) {
    this.signalCode = signal;
    this.emit('exit', null, signal);
  }
}
function assertNoListeners(child) {
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
}

test('absent, never-spawned and already-exited sessions need no signal', async () => {
  await stopPrivateSession(undefined);
  const unspawned = new FakeChild();
  unspawned.pid = undefined;
  await stopPrivateSession(unspawned);
  assert.deepEqual(unspawned.signals, []);
  const exited = new FakeChild();
  exited.exitCode = 0;
  await stopPrivateSession(exited);
  assert.deepEqual(exited.signals, []);
});

test('SIGTERM requests shutdown and confirms the native exit state', async () => {
  const child = new FakeChild(function (signal) {
    setTimeout(() => this.exitBySignal(signal), 2);
    return false; // Return value is deliberately not treated as exit proof.
  });
  await stopPrivateSession(child, { graceMs: 50, killMs: 50 });
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(child.signalCode, 'SIGTERM');
  assertNoListeners(child);
});

test('unresponsive SIGTERM escalates to SIGKILL and still waits for confirmed exit', async () => {
  const child = new FakeChild(function (signal) {
    if (signal === 'SIGKILL') setTimeout(() => this.exitBySignal(signal), 2);
    return true;
  });
  await stopPrivateSession(child, { graceMs: 3, killMs: 50 });
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.signalCode, 'SIGKILL');
  assertNoListeners(child);
});

test('a still-running process retains its lock even when kill returned true', async () => {
  const child = new FakeChild(() => true);
  await assert.rejects(
    stopPrivateSession(child, { graceMs: 3, killMs: 3 }),
    /lock must be retained/i,
  );
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assertNoListeners(child);
});

test('a forged exit event without exitCode or signalCode is not proof of shutdown', async () => {
  const child = new FakeChild(function () {
    setTimeout(() => this.emit('exit', null, 'SIGTERM'), 1);
    return true;
  });
  await assert.rejects(
    stopPrivateSession(child, { graceMs: 3, killMs: 3 }),
    /lock must be retained/i,
  );
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assertNoListeners(child);
});

test('signal errors and asynchronous child errors fail closed without leaking listeners', async () => {
  const throws = new FakeChild(() => {
    throw Error('cannot signal');
  });
  await assert.rejects(
    stopPrivateSession(throws, { graceMs: 3, killMs: 3 }),
    /lock must be retained/i,
  );
  assertNoListeners(throws);
  const errors = new FakeChild(function () {
    setTimeout(() => this.emit('error', Error('process error')), 1);
    return true;
  });
  await assert.rejects(
    stopPrivateSession(errors, { graceMs: 20, killMs: 20 }),
    /lock must be retained/i,
  );
  assertNoListeners(errors);
});

test('already-exited and malformed process states are not confused', async () => {
  const child = new FakeChild();
  child.pid = 0;
  await assert.rejects(stopPrivateSession(child), /lock must be retained/i);
  child.pid = 12345;
  child.exitCode = undefined;
  await assert.rejects(stopPrivateSession(child), /lock must be retained/i);
  child.exitCode = 0;
  child.signalCode = null;
  await stopPrivateSession(child);
  assertNoListeners(child);
});

test('timeouts are strictly bounded and an existing error listener remains intact', async () => {
  const child = new FakeChild(function (signal) {
    setTimeout(() => this.exitBySignal(signal), 1);
  });
  const existing = () => {};
  child.on('error', existing);
  await assert.rejects(stopPrivateSession(child, { graceMs: -1 }), /lock must be retained/i);
  await assert.rejects(stopPrivateSession(child, { killMs: 60_001 }), /lock must be retained/i);
  await stopPrivateSession(child, { graceMs: 50, killMs: 50 });
  assert.equal(child.listenerCount('exit'), 0);
  assert.deepEqual(child.listeners('error'), [existing]);
});

for (const ignoreTerm of [false, true]) {
  test(`a real local child ${ignoreTerm ? 'requires SIGKILL' : 'exits after SIGTERM'}`, { timeout: 5_000 }, async () => {
    const source = `process.on('SIGTERM', () => ${ignoreTerm ? '{}' : 'process.exit(0)'});` +
      `process.stdout.write('ready\\n');setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const [ready] = await once(child.stdout, 'data');
      assert.equal(ready.toString(), 'ready\n');
      await stopPrivateSession(child, { graceMs: 50, killMs: 1_000 });
      if (ignoreTerm) assert.equal(child.signalCode, 'SIGKILL');
      else assert.equal(child.exitCode, 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
}
