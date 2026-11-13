// Business-wide settings: testing mode (scan override + scan bypass for everyone)
//   npm run test:settings
import assert from 'node:assert/strict';
import { bootDb, rpc } from './harness.mjs';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log(`  ✓ ${name}`); }
  catch (e) { results.push(false); console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`); }
}
async function rejects(promise, pattern) {
  try { await promise; } catch (e) { if (pattern && !pattern.test(e.message)) throw new Error(`Expected ${pattern}, got: ${e.message}`); return; }
  throw new Error(`Expected an error matching ${pattern}`);
}
const db = await bootDb();
console.log('\nTorte Living OS — app settings\n');

await test('Testing mode starts on, every staff member can read it, and the dashboard says so', async () => {
  assert.equal((await rpc(db, 'packer', 'get_app_settings')).testing_mode, true);
  const d = await rpc(db, 'admin', 'get_dashboard', { p_days: 30 });
  assert.ok(d.alerts.some((a) => a.type === 'testing_mode'));
});
await test('Only an admin can switch it; the public key cannot read it', async () => {
  await rejects(rpc(db, 'warehouse', 'set_app_setting', { p_key: 'testing_mode', p_value: false }), /not allowed/);
  await rejects(rpc(db, 'anon', 'get_app_settings'), /permission denied/);
  await rejects(rpc(db, 'admin', 'set_app_setting', { p_key: 'testing_mode', p_value: '"yes"' }), /on or off/);
  await rejects(rpc(db, 'admin', 'set_app_setting', { p_key: 'anything', p_value: true }), /check constraint|violates/);
  assert.equal((await rpc(db, 'admin', 'set_app_setting', { p_key: 'testing_mode', p_value: false })).testing_mode, false);
  const d = await rpc(db, 'admin', 'get_dashboard', { p_days: 30 });
  assert.ok(!d.alerts.some((a) => a.type === 'testing_mode'));
});

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
