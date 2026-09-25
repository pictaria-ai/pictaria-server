import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.mjs';
import { SettingsStore } from '../../src/settings.mjs';
const available = { stack: true, keeper: true };
function fixture(t, { state, env = {}, availability } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'curate-ai-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'settings.json');
  if (state) writeFileSync(filePath, JSON.stringify(state));
  const open = (overrides = {}) => {
    const config = loadConfig({ ...env, ...overrides });
    const store = new SettingsStore({ filePath, config, env: { ...env, ...overrides }, curateAiAvailability: availability }).load();
    return { store, config };
  };
  return { ...open(), open, persisted: () => JSON.parse(readFileSync(filePath, 'utf8')) };
}
const legacy = (overrides = {}) => ({ version: 7, credentialBindings: {}, ...overrides });

test('fresh install defaults off, uncertain scope; API cannot activate unavailable roles, including null fallback', t => {
  const { store, config, persisted } = fixture(t, { env: { CURATE_KEEPER_REFEREE_ENABLED: 'true' },
    state: { version: 8, credentialBindings: {}, curate: { keeperRefereeEnabled: false } } });
  for (const key of ['stackRefereeEnabled', 'keeperRefereeEnabled']) {
    assert.equal(store.describe().curate[key].value, false);
    assert.equal(store.describe().curate[key].available, false);
    assert.equal(store.describe().curate[key].active, false);
    const before = persisted();
    assert.throws(() => store.update({ curate: { [key]: true, refereeModel: 'must-not-save' } }), /not available/);
    assert.deepEqual(persisted(), before);
  }
  assert.throws(() => store.update({ curate: { keeperRefereeEnabled: null } }), /not available/);
  assert.equal(config.curateStackRefereeScope, 'uncertain');
  const fresh = fixture(t);
  assert.equal(fresh.config.curateStackRefereeEnabled, false);
  assert.equal(fresh.config.curateKeeperRefereeEnabled, false);
  assert.equal(loadConfig({ CURATE_REFEREE_ENABLED: 'true' }).curateKeeperRefereeEnabled, false);
  assert.throws(() => loadConfig({ CURATE_STACK_REFEREE_SCOPE: 'typo' }), /uncertain or all/);
  assert.throws(() => store.update({ curate: { stackRefereeScope: 'typo' } }), /stackRefereeScope/);
});

test('upgrade snapshots effective legacy keeper preference once, without turning on Stack Referee', t => {
  for (const enrich of [false, true]) for (const stacks of [false, true]) for (const referee of [false, true]) {
    const f = fixture(t, { state: legacy(), env: { ENRICH_ENABLED: String(enrich),
      CURATE_BURST_GROUPING: String(stacks), CURATE_REFEREE_ENABLED: String(referee) } });
    const expected = enrich && stacks && referee;
    assert.equal(f.config.curateKeeperRefereeEnabled, expected);
    assert.equal(f.persisted().curate.keeperRefereeEnabled, expected);
    assert.equal(f.config.curateRefereeEnabled, referee, 'legacy preference preserved separately');
    assert.equal(f.config.curateStackRefereeEnabled, false);
    assert.equal(f.store.describe().curate.keeperRefereeEnabled.active, false);
    f.store.update({ curate: { refereeModel: 'custom' } });
    const restarted = f.open({ ENRICH_ENABLED: String(!enrich), CURATE_REFEREE_ENABLED: String(!referee) });
    assert.equal(restarted.config.curateKeeperRefereeEnabled, expected, 'restart cannot reinterpret legacy state');
    assert.equal(restarted.config.curateRefereeModel, 'custom');
    if (expected) {
      restarted.store.update({ curate: { keeperRefereeEnabled: false } });
      assert.equal(f.open().config.curateKeeperRefereeEnabled, false, 'may opt out before worker is available');
    }
  }
});

test('saved legacy overrides beat environment; explicit new preferences beat migration', t => {
  for (const input of [
    { state: legacy({ enrich: { enabled: true }, curate: { refereeEnabled: true } }),
      env: { CURATE_KEEPER_REFEREE_ENABLED: '' }, expected: true },
    { state: legacy({ enrich: { enabled: false } }), env: { ENRICH_ENABLED: 'true', CURATE_REFEREE_ENABLED: 'true' }, expected: false },
    { state: legacy({ enrich: { enabled: true }, curate: { refereeEnabled: true, burstGrouping: true } }),
      env: { ENRICH_ENABLED: 'false', CURATE_REFEREE_ENABLED: 'false', CURATE_BURST_GROUPING: 'false' }, expected: true },
    { state: legacy({ enrich: { enabled: true }, curate: { refereeEnabled: true } }),
      env: { CURATE_KEEPER_REFEREE_ENABLED: 'false' }, expected: false },
    { state: legacy({ curate: { keeperRefereeEnabled: false } }),
      env: { CURATE_KEEPER_REFEREE_ENABLED: 'true' }, expected: false },
    { state: legacy(), env: { CURATE_KEEPER_REFEREE_ENABLED: 'true' }, expected: true },
  ]) assert.equal(fixture(t, input).config.curateKeeperRefereeEnabled, input.expected);
});

test('available role controls save independently of Enrich; Stacks pauses and preserves both choices and scope', t => {
  const f = fixture(t, { availability: available });
  f.store.update({ curate: { stackRefereeEnabled: true, stackRefereeScope: 'all', keeperRefereeEnabled: true } });
  assert.equal(f.config.enrichEnabled, false);
  assert.equal(f.store.describe().curate.stackRefereeEnabled.active, true);
  assert.equal(f.store.describe().curate.keeperRefereeEnabled.active, true);
  f.store.update({ curate: { burstGrouping: false } });
  for (const key of ['stackRefereeEnabled', 'keeperRefereeEnabled']) {
    assert.equal(f.store.describe().curate[key].active, false);
    assert.equal(f.store.describe().curate[key].value, true);
  }
  const restarted = f.open();
  restarted.store.update({ curate: { burstGrouping: true, keeperRefereeEnabled: false } });
  assert.equal(restarted.store.describe().curate.stackRefereeEnabled.active, true);
  assert.equal(restarted.store.describe().curate.keeperRefereeEnabled.active, false);
  assert.equal(restarted.config.curateStackRefereeScope, 'all');
  assert.equal(restarted.config.curateRefereeEnabled, false, 'preview controls do not start the legacy worker');
});
