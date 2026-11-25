import assert from 'node:assert/strict';
import test from 'node:test';
import { relayAccessError } from '../dist/ipc.js';

test('Windows pipe permission failures explain recovery without hiding the cause', () => {
  const denied = Object.assign(new Error('connect EPERM'), { code: 'EPERM' });
  assert.throws(() => relayAccessError(denied, 'win32'), error =>
    error.cause === denied && /normal terminal/.test(error.message) && /fresh client sessions/.test(error.message));
  assert.throws(() => relayAccessError(denied, 'linux'), error => error === denied);
  const other = Object.assign(new Error('different failure'), { code: 'EIO' });
  assert.throws(() => relayAccessError(other, 'win32'), error => error === other);
});
