import test from 'node:test';
import assert from 'node:assert/strict';

import { createAuthAdmissionGate, createAuthFailureLimiter } from '../src/authFailureLimiter.mjs';
import { createClientAddressResolver } from '../src/trustedProxy.mjs';

function request(peer, forwardedFor) {
  return {
    socket: { remoteAddress: peer },
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  };
}

test('client resolver ignores forwarding headers from untrusted peers', () => {
  const resolve = createClientAddressResolver('10.0.0.0/8');
  assert.equal(resolve(request('192.0.2.1', '198.51.100.1')), '192.0.2.1');
});

test('client resolver walks a trusted forwarding chain from right to left', () => {
  const resolve = createClientAddressResolver('127.0.0.1, 10.0.0.0/8');
  assert.equal(resolve(request('127.0.0.1', '203.0.113.99, 198.51.100.7, 10.0.0.8')), '198.51.100.7');
});

test('client resolver normalizes IPv4-mapped peers and fails closed on malformed chains', () => {
  const resolve = createClientAddressResolver('127.0.0.1');
  assert.equal(resolve(request('::ffff:127.0.0.1', '198.51.100.7')), '198.51.100.7');
  assert.equal(resolve(request('::ffff:7f00:1', '198.51.100.8')), '198.51.100.8');
  assert.equal(resolve(request('127.0.0.1', '198.51.100.7, not-an-ip')), '127.0.0.1');
});

test('client resolver canonicalizes equivalent IPv6 client spellings', () => {
  const resolve = createClientAddressResolver('2001:db8:ffff::/48');
  assert.equal(
    resolve(request('2001:db8:ffff::1', '2001:0db8:0001:0000:0000:0000:0000:0001')),
    '2001:db8:1::1',
  );
});

test('client resolver rejects invalid trusted-proxy configuration', () => {
  assert.throws(() => createClientAddressResolver('10.0.0.0/99'), /invalid CIDR/);
  assert.throws(() => createClientAddressResolver('0.0.0.0/0'), /invalid CIDR/);
  assert.throws(() => createClientAddressResolver('proxy.local'), /invalid IP address/);
});

test('failure limiter isolates clients and tracks a higher global threshold', () => {
  let clock = 1_000;
  const limiter = createAuthFailureLimiter({
    windowMs: 10_000,
    clientLimit: 2,
    clientLockoutMs: 5_000,
    globalLimit: 4,
    globalLockoutMs: 1_000,
    now: () => clock,
  });

  limiter.recordFailure('client-a');
  limiter.recordFailure('client-a');
  assert.equal(limiter.remainingMs('client-a'), 5_000);
  assert.equal(limiter.remainingMs('client-b'), 0);

  limiter.recordFailure('client-b');
  limiter.recordFailure('client-c');
  assert.equal(limiter.remainingMs('client-d'), 1_000);
  assert.equal(limiter.clientRemainingMs('client-d'), 0);
  assert.equal(limiter.globalRemainingMs(), 1_000);

  clock += 1_001;
  assert.equal(limiter.remainingMs('client-d'), 0, 'completed global lockout starts a fresh budget');
  assert.equal(limiter.globalRemainingMs(), 0);
  assert.ok(limiter.remainingMs('client-a') > 0, 'client lockout remains independent');
});

test('client lockout lasts from the threshold even when the counting window ends first', () => {
  let clock = 1_000;
  const limiter = createAuthFailureLimiter({
    windowMs: 10_000,
    clientLimit: 2,
    clientLockoutMs: 5_000,
    globalLimit: 100,
    now: () => clock,
  });

  limiter.recordFailure('client-a');
  clock = 10_999;
  limiter.recordFailure('client-a');
  clock = 11_001;
  assert.equal(limiter.remainingMs('client-a'), 4_998);

  clock = 16_000;
  assert.equal(limiter.remainingMs('client-a'), 0);
});

test('global lockout lasts from the threshold even when the counting window ends first', () => {
  let clock = 1_000;
  const limiter = createAuthFailureLimiter({
    windowMs: 10_000,
    clientLimit: 100,
    globalLimit: 2,
    globalLockoutMs: 1_000,
    now: () => clock,
  });

  limiter.recordFailure('client-a');
  clock = 10_999;
  limiter.recordFailure('client-b');
  clock = 11_001;
  assert.equal(limiter.remainingMs('client-c'), 998);

  clock = 12_000;
  assert.equal(limiter.remainingMs('client-c'), 0);
});

test('failure limiter keeps a fixed-size, recently-used client set', () => {
  const limiter = createAuthFailureLimiter({
    clientLimit: 2,
    maxClients: 2,
  });

  limiter.recordFailure('client-a');
  limiter.recordFailure('client-b');
  limiter.recordFailure('client-a'); // refresh client-a before inserting c
  limiter.recordFailure('client-c');

  assert.ok(limiter.clientRemainingMs('client-a') > 0, 'recently active client remains tracked');
  assert.equal(limiter.clientRemainingMs('client-b'), 0, 'oldest client was predictably evicted');
  assert.equal(limiter.clientRemainingMs('client-c'), 0, 'new client was admitted');
});

test('authentication admission rejects overflow without queueing it', () => {
  const gate = createAuthAdmissionGate({ limit: 2 });
  const releaseA = gate.tryAcquire();
  const releaseB = gate.tryAcquire();
  assert.equal(typeof releaseA, 'function');
  assert.equal(typeof releaseB, 'function');
  assert.equal(gate.tryAcquire(), null);

  releaseA();
  const releaseC = gate.tryAcquire();
  assert.equal(typeof releaseC, 'function');
  releaseA(); // idempotent: a second release cannot create an extra slot
  assert.equal(gate.tryAcquire(), null);
  releaseB();
  releaseC();
});

test('global-only failures never consume a client lockout budget', () => {
  const limiter = createAuthFailureLimiter({
    clientLimit: 1,
    globalLimit: 2,
  });
  limiter.recordGlobalFailure();
  limiter.recordGlobalFailure();

  assert.equal(limiter.clientRemainingMs('valid-client'), 0);
  assert.ok(limiter.globalRemainingMs() > 0);
});
