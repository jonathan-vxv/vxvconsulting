import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRows, parseInputs, buildWrite, isPermutation, summarize, headersOk, versionOf, ROW_COUNT } from '../src/sheet.js';
import { passwordMatches, createSession, hasSession, isLocked, recordFail, clearFails, configError } from '../src/auth.js';

const formulas = [
  ['Brennan', 'Vendor A - Inv 1', '', -100],
  ['', '', '', ''],                     // blank row in the middle is skipped
  ['', 'Pending client payment', '=C5', '=$C$4'],
  ['Kinports', 'Vendor B', '11/20/2026', -50.25],
];
const values = [
  ['Brennan', 'Vendor A - Inv 1', '', -100],
  [],
  ['', 'Pending client payment', '11/30/2026', 300],
  ['Kinports', 'Vendor B', '11/20/2026', -50.25],
];

test('parseRows skips blanks, keeps formulas in raw and flags the incoming row', () => {
  const rows = parseRows(formulas, values);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].incoming, true);
  assert.equal(rows[1].amount, 300);
  assert.deepEqual(rows[1].raw, ['', 'Pending client payment', '=C5', '=$C$4']);
  assert.equal(rows[0].incoming, false);
});

test('buildWrite reorders B-E, keeps formulas, pads to 40 rows and protects number-like text', () => {
  const rows = parseRows(formulas, values);
  rows[0].raw[0] = '2024'; // a project name that USER_ENTERED would turn into a number
  const grid = buildWrite(rows, [1, 2, 0]);
  assert.equal(grid.length, ROW_COUNT);
  assert.ok(grid.every((r) => r.length === 4));
  assert.deepEqual(grid[0], ['', 'Pending client payment', '=C5', '=$C$4']);
  assert.deepEqual(grid[2], ["'2024", 'Vendor A - Inv 1', '', -100]);
  assert.deepEqual(grid[3], ['', '', '', '']);
});

test('isPermutation', () => {
  assert.ok(isPermutation([2, 0, 1], 3));
  assert.ok(!isPermutation([0, 0, 1], 3));
  assert.ok(!isPermutation([0, 1], 3));
  assert.ok(!isPermutation([0, 1, 3], 3));
  assert.ok(!isPermutation('012', 3));
  assert.ok(!isPermutation([0, 1, 1.5], 3));
});

test('summary matches the sheet example', () => {
  // From the live sheet on 2026-11-18: start 143,846; first payment 108,417 -> 35,429
  const s = summarize(143846, [-108417, -50000, 203550]);
  assert.deepEqual(s.running, [35429, -14571, 188979]);
  assert.equal(s.lowest, -14571);
  assert.equal(s.shortfall, 14571);
  assert.equal(s.totalOwed, 158417);
  assert.equal(s.cashIn, 203550);
  assert.equal(s.ok, false);
});

test('inputs, headers and version', async () => {
  assert.deepEqual(parseInputs([[143846], [203550], ['11/30/2026']]), { startingBalance: 143846, incomingAmount: 203550, incomingDate: '11/30/2026' });
  assert.ok(headersOk(['Project', 'Vendor', 'Date', 'Amount']));
  assert.ok(!headersOk(['Vendor', 'Project', 'Date', 'Amount']));
  const v1 = await versionOf(formulas, [[1]]);
  assert.equal(v1, await versionOf(formulas, [[1]]));
  assert.notEqual(v1, await versionOf(formulas, [[2]]));
  assert.notEqual(v1, await versionOf([formulas[3], formulas[0]], [[1]]));
});

const env = { SITE_PASSWORD: 'order', SESSION_SECRET: 'x'.repeat(40) };
const reqWith = (cookieHeader) => ({ headers: { get: (n) => (n === 'Cookie' ? cookieHeader : null) } });
const cookieOf = (setCookie) => setCookie.split(';')[0];

test('password check and config', async () => {
  assert.equal(configError(env), null);
  assert.ok(configError({ SITE_PASSWORD: 'order', SESSION_SECRET: 'short' }));
  assert.ok(await passwordMatches(env, 'order'));
  assert.ok(!(await passwordMatches(env, 'Order')));
  assert.ok(!(await passwordMatches(env, '')));
  const hashed = { SITE_PASSWORD_SHA256: 'f26e1a0bf3cb5e6ecdcb1d4cd5a4fd8e6c01d55c0d0ae86ab5f1e3f8fb2b6c3c', SESSION_SECRET: env.SESSION_SECRET };
  assert.ok(!(await passwordMatches(hashed, 'order'))); // not the hash of "order"
});

test('session cookie is signed, flagged and tied to the password', async () => {
  const set = await createSession(env);
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  assert.match(set, /SameSite=Strict/);
  assert.match(set, /Max-Age=345600/);
  const c = cookieOf(set);
  assert.ok(await hasSession(env, reqWith(c)));
  assert.ok(!(await hasSession(env, reqWith(c.slice(0, -2) + 'AA'))));          // tampered signature
  assert.ok(!(await hasSession({ ...env, SITE_PASSWORD: 'new' }, reqWith(c)))); // password changed
  assert.ok(!(await hasSession({ ...env, SESSION_SECRET: 'y'.repeat(40) }, reqWith(c))));
  assert.ok(!(await hasSession(env, reqWith(''))));
});

test('rate limit locks after 5 wrong guesses', async () => {
  const ip = '203.0.113.9';
  for (let i = 0; i < 5; i++) {
    assert.ok(!(await isLocked(env, ip)));
    await recordFail(env, ip);
  }
  assert.ok(await isLocked(env, ip));
  await clearFails(env, ip);
  assert.ok(!(await isLocked(env, ip)));
});
