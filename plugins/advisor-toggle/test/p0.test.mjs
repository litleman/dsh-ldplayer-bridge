// P0 回归测试：计划号生命周期、工具快照、非截断摘要、浏览器 nonce、重载即作废授权。
// 跑法: node --test test/p0.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../index.js');
const { gateDecision, stateOf, contentVersion, makeGrant, nonceIssue, DEFAULTS } = mod.__test;

const H64 = /^[0-9a-f]{64}$/;

test('授权摘要不截断：内容版本是完整 64 位 SHA-256', async () => {
  const v = await contentVersion({ maxAgeMs: 0 });
  if (v.startsWith('untrusted-')) {
    assert.match(v.slice('untrusted-'.length), H64, 'git 不可用时的兜底摘要也必须完整');
  } else {
    const [, digest] = /^([0-9a-f]{7,40})(?:\+([0-9a-f]{64}))?$/.exec(v) || [];
    assert.ok(digest, `版本应为 <head>+<64 位摘要>，实际 ${v}`);
  }
});

test('makeGrant 绑定计划号、工具快照与完整摘要', () => {
  const state = { planDigest: 'pd', toolSnapshotDigest: 'snap-1' };
  const g = makeGrant({ state, version: 'v1', planId: 'plan-A', round: 1 });
  assert.equal(g.planId, 'plan-A');
  assert.equal(g.toolSnapshotDigest, 'snap-1');
  assert.match(g.digest, H64, 'grant 摘要用完整 SHA-256');
  assert.equal(g.used, 0);
  assert.ok(g.expiresAt > Date.now());
});

test('上一个计划的授权不能放行这一批活', () => {
  const state = {
    enabled: true,
    activePlanId: 'plan-B',
    planDigest: 'pd',
    toolSnapshotDigest: 'snap-1',
    grant: { id: 'b1', planId: 'plan-A', version: 'v1', expiresAt: Date.now() + 60000, used: 0 },
  };
  const d = gateDecision(state, 'pwsh', 'v1', Date.now(), { trusted: true });
  assert.equal(d.allow, false);
  assert.equal(state.grant, null, '计划不符要直接作废授权');
  assert.equal(state.grantExpired, 'plan-mismatch');
  assert.match(d.reason, /属于另一个计划/);
});

test('工具集变过（重载/新装工具）后旧授权失效', () => {
  const state = {
    enabled: true,
    activePlanId: 'plan-A',
    toolSnapshotDigest: 'snap-2',
    grant: { id: 'b1', planId: 'plan-A', version: 'v1', toolSnapshotDigest: 'snap-1', expiresAt: Date.now() + 60000, used: 0 },
  };
  const d = gateDecision(state, 'write', 'v1', Date.now(), { trusted: true });
  assert.equal(d.allow, false);
  assert.equal(state.grantExpired, 'tool-snapshot');
  assert.match(d.reason, /工具集变化/);
});

test('同一计划内版本漂移放行但标记 granted-drift（残余 TOCTOU 可见）', () => {
  const state = {
    enabled: true,
    activePlanId: 'plan-A',
    toolSnapshotDigest: 'snap-1',
    grant: { id: 'b1', planId: 'plan-A', version: 'v1', toolSnapshotDigest: 'snap-1', expiresAt: Date.now() + 60000, maxOps: 10, used: 0 },
  };
  const d = gateDecision(state, 'write', 'v2', Date.now(), { trusted: true });
  assert.equal(d.allow, true);
  assert.equal(d.why, 'granted-drift');
  assert.equal(d.grantVersion, 'v1');
  assert.equal(d.currentVersion, 'v2');
});

test('浏览器 nonce：首次注册放行、匹配放行、不匹配拒绝、强制模式下未注册拒绝', () => {
  const fresh = stateOf('p0-nonce');
  assert.equal(nonceIssue(fresh, { clientNonce: '' }), '', '没注册时默认放行（兼容旧页面）');

  fresh.clientNonce = 'n-1';
  assert.equal(nonceIssue(fresh, { clientNonce: 'n-1' }), '');
  assert.equal(nonceIssue(fresh, { clientNonce: 'n-2' }), 'nonce_mismatch');
  assert.equal(nonceIssue(fresh, {}), '', '没带 nonce 按兼容处理（留日志）');

  const strict = stateOf('p0-nonce-strict');
  const prev = DEFAULTS.requireClientNonce;
  DEFAULTS.requireClientNonce = true;
  try {
    assert.equal(nonceIssue(strict, {}), 'client_not_registered');
  } finally {
    DEFAULTS.requireClientNonce = prev;
  }
});

test('插件重载（apply）会清空所有会话状态，旧授权不可能跨实现复用', async () => {
  const state = stateOf('p0-apply');
  state.enabled = true;
  state.grant = { id: 'b1', version: 'v1', expiresAt: Date.now() + 60000, used: 0 };

  const ctx = { get: () => undefined, on: () => undefined, effect: () => undefined };
  mod.apply(ctx, {});

  const after = stateOf('p0-apply');
  assert.notEqual(after, state, 'apply 后应是全新的状态对象');
  assert.equal(after.enabled, false);
  assert.equal(after.grant, null);
});

test('授权绑定字段缺失一律 fail-closed（HIGH-1 / HIGH-2）', () => {
  const base = () => ({ enabled: true, grant: null, activePlanId: 'plan-A', toolSnapshotDigest: 'snap', degradedAt: 0, deniedStreak: 0, lastFailureAt: 0 })
  const grantWith = (patch) => ({ id: 'g', planId: 'plan-A', version: 'v1', digest: 'd', toolSnapshotDigest: 'snap', at: Date.now(), expiresAt: Date.now() + 60000, maxOps: 10, used: 0, round: 1, ...patch })
  const run = (statePatch, grantPatch) => { const s = { ...base(), ...statePatch }; s.grant = grantWith(grantPatch); return gateDecision(s, 'write', 'v1', Date.now(), { trusted: true }).allow }

  assert.equal(run({}, {}), true, '完整字段应放行')
  assert.equal(run({}, { expiresAt: 0 }), false, '缺 expiresAt 必须拒绝（不能永不过期）')
  assert.equal(run({}, { planId: '' }), false, '缺 planId 必须拒绝')
  assert.equal(run({ activePlanId: '' }, {}), false, 'state 缺 activePlanId 必须拒绝')
  assert.equal(run({}, { toolSnapshotDigest: '' }), false, '缺 toolSnapshotDigest 必须拒绝')
  assert.equal(run({ toolSnapshotDigest: '' }, {}), false, 'state 缺 toolSnapshotDigest 必须拒绝')
})

test('makeGrant 拒绝缺失绑定字段，且总带合法 expiresAt', () => {
  const state = { toolSnapshotDigest: 'snap', planDigest: 'pd' }
  assert.throws(() => makeGrant({ state, version: 'v1', planId: '', round: 1 }), /planId/)
  assert.throws(() => makeGrant({ state: { planDigest: 'pd' }, version: 'v1', planId: 'plan-A', round: 1 }), /toolSnapshotDigest/)
  const g = makeGrant({ state, version: 'v1', planId: 'plan-A', round: 1 })
  assert.ok(g.expiresAt > g.at, 'expiresAt 必须晚于 at')
})
