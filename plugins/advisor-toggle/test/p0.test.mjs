// P0 回归测试：计划号生命周期、工具快照、非截断摘要、浏览器 nonce、重载即作废授权。
// 跑法: node --test test/p0.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

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
  const state = { planDigest: 'pd', toolSnapshotDigest: 'snap-1', toolSnapshotTrusted: true };
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
    phase: 'executing',
    activePlanId: 'plan-B',
    planDigest: 'pd',
    toolSnapshotDigest: 'snap-1',
    grant: { id: 'b1', planId: 'plan-A', version: 'v1', digest: 'd'.repeat(64), toolSnapshotDigest: 'snap-1', at: Date.now(), expiresAt: Date.now() + 60000, totalDeadline: Date.now() + 3600000, maxOps: 10, used: 0, totalOpsLimit: 600, totalUsed: 0, renewalCount: 0, maxRenewals: 3, idleTimeout: 1800000, lastActivityAt: Date.now() , allowShell: true, allowedPaths: [] }
  };
  const d = gateDecision(state, 'pwsh', 'v1', Date.now(), { trusted: true });
  assert.equal(d.allow, false);
  assert.equal(state.grant, null, '计划不符要直接作废授权');
  assert.equal(state.grantExpired, 'plan-mismatch');
  assert.match(d.message, /不属于当前计划/);
});

test('工具集变过（重载/新装工具）后旧授权失效', () => {
  const state = {
    enabled: true,
    phase: 'executing',
    activePlanId: 'plan-A',
    toolSnapshotDigest: 'snap-2',
    grant: { id: 'b1', planId: 'plan-A', version: 'v1', digest: 'd'.repeat(64), toolSnapshotDigest: 'snap-1', at: Date.now(), expiresAt: Date.now() + 60000, totalDeadline: Date.now() + 3600000, maxOps: 10, used: 0, totalOpsLimit: 600, totalUsed: 0, renewalCount: 0, maxRenewals: 3, idleTimeout: 1800000, lastActivityAt: Date.now() , allowShell: true, allowedPaths: [] }
  };
  const d = gateDecision(state, 'write', 'v1', Date.now(), { trusted: true });
  assert.equal(d.allow, false);
  assert.equal(state.grantExpired, 'tool-snapshot-mismatch');
  assert.match(d.message, /工具集变化/);
});

test('同一计划内版本漂移放行但标记 granted-drift（残余 TOCTOU 可见）', () => {
  const state = {
    enabled: true,
    phase: 'executing',
    activePlanId: 'plan-A',
    toolSnapshotDigest: 'snap-1',
    grant: { id: 'b1', planId: 'plan-A', version: 'v1', digest: 'd'.repeat(64), toolSnapshotDigest: 'snap-1', at: Date.now(), expiresAt: Date.now() + 60000, totalDeadline: Date.now() + 3600000, maxOps: 10, used: 0, totalOpsLimit: 600, totalUsed: 0, renewalCount: 0, maxRenewals: 3, idleTimeout: 1800000, lastActivityAt: Date.now() , allowShell: true, allowedPaths: [] }
  };
  const d = gateDecision(state, 'pwsh', 'v2', Date.now(), { trusted: true });
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
  const base = () => ({ enabled: true, phase: 'executing', grant: null, activePlanId: 'plan-A', toolSnapshotDigest: 'snap', degradedAt: 0, deniedStreak: 0, lastFailureAt: 0 })
  const grantWith = (patch) => ({ id: 'g', planId: 'plan-A', version: 'v1', digest: 'd'.repeat(64), toolSnapshotDigest: 'snap', at: Date.now(), expiresAt: Date.now() + 60000, totalDeadline: Date.now() + 3600000, maxOps: 10, used: 0, totalOpsLimit: 600, totalUsed: 0, renewalCount: 0, maxRenewals: 3, idleTimeout: 1800000, lastActivityAt: Date.now(), allowShell: true, allowedPaths: [], round: 1, ...patch })
  const run = (statePatch, grantPatch) => { const s = { ...base(), ...statePatch }; s.grant = grantWith(grantPatch); return gateDecision(s, 'pwsh', 'v1', Date.now(), { trusted: true }).allow }

  assert.equal(run({}, {}), true, '完整字段应放行')
  assert.equal(run({}, { expiresAt: 0 }), false, '缺 expiresAt 必须拒绝（不能永不过期）')
  assert.equal(run({}, { planId: '' }), false, '缺 planId 必须拒绝')
  assert.equal(run({ activePlanId: '' }, {}), false, 'state 缺 activePlanId 必须拒绝')
  assert.equal(run({}, { toolSnapshotDigest: '' }), false, '缺 toolSnapshotDigest 必须拒绝')
  assert.equal(run({ toolSnapshotDigest: '' }, {}), false, 'state 缺 toolSnapshotDigest 必须拒绝')
})

test('makeGrant 拒绝缺失绑定字段，且总带合法 expiresAt', () => {
  const state = { toolSnapshotDigest: 'snap', toolSnapshotTrusted: true, planDigest: 'pd' }
  assert.throws(() => makeGrant({ state, version: 'v1', planId: '', round: 1 }), /planId/)
  assert.throws(() => makeGrant({ state: { planDigest: 'pd', toolSnapshotTrusted: true }, version: 'v1', planId: 'plan-A', round: 1 }), /toolSnapshotDigest/)
  const g = makeGrant({ state, version: 'v1', planId: 'plan-A', round: 1 })
  assert.ok(g.expiresAt > g.at, 'expiresAt 必须晚于 at')
})

test('HIGH-3：读不到真实工具表时不许签发写授权', () => {
  // 工具表不可用（digest 退回固定标记、trusted=false）→ makeGrant 必须抛错，
  // 而不是把"固定标记"当成合法快照盖出一张能用的写授权。
  const untrusted = { toolSnapshotDigest: 'advisor-only-fallback', toolSnapshotTrusted: false, planDigest: 'pd' }
  assert.throws(() => makeGrant({ state: untrusted, version: 'v1', planId: 'plan-X', round: 1 }), /不可信/)

  // 状态对象默认就是不可信：新会话在没读到工具表之前不能有写授权。
  assert.equal(stateOf('p0-untrusted-default').toolSnapshotTrusted, false)
})

test('C4：只认宿主上下文里的 tools，且每次现取（旧服务不被采用）', async () => {
  const { __test } = mod
  let calls = 0
  const serviceA = { list: async () => { calls += 1; return [{ name: 'read' }, { name: 'pwsh' }] } }
  const serviceB = { list: async () => { calls += 1; return [{ name: 'read' }, { name: 'write' }, { name: 'pwsh' }] } }
  let current = serviceA
  const host = { get: (name) => (name === 'tools' ? current : undefined) }

  __test.setHostContext(host)
  try {
    assert.equal(__test.resolveTools(), serviceA)
    const first = await __test.toolSnapshotOf()
    assert.equal(first.trusted, true)
    // 宿主在同一上下文里替换服务 → 下一次现取必须是新服务，不需要重新 apply。
    current = serviceB
    assert.equal(__test.resolveTools(), serviceB)
    const second = await __test.toolSnapshotOf()
    assert.equal(second.trusted, true)
    assert.notEqual(first.digest, second.digest)
    assert.equal(calls, 2, '每次解析都应重新调用 list()，不允许缓存结果')
    // 服务被移除 → 立刻回到不可信，不能拿上一份摘要冒充。
    current = undefined
    const third = await __test.toolSnapshotOf()
    assert.equal(third.trusted, false)
    assert.equal(third.reason, 'no-tools-service')
  } finally {
    __test.setHostContext(null)
  }
})

test('R2：写前复核工具集——每次写都重取，变了就作废本批授权', async () => {
  const { __test } = mod
  const { enforceToolSnapshot } = __test
  let calls = 0
  let names = ['read', 'pwsh']
  let mode = 'ok'
  const host = {
    get: (name) => (name === 'tools'
      ? {
          list: async () => {
            calls += 1
            if (mode === 'throw') throw new Error('tools service exploded')
            return names.map((n) => ({ name: n }))
          },
        }
      : undefined),
  }
  __test.setHostContext(host)
  try {
    // 没有授权时不比快照（只读/未开启的路径不该被这里拦）。
    const noGrant = await enforceToolSnapshot({ grant: null })
    assert.equal(noGrant.ok, true)

    const stable = await __test.toolSnapshotOf()
    assert.equal(stable.trusted, true)
    const state = { grant: { id: 'g1' }, toolSnapshotDigest: stable.digest }

    // 工具集没变：放行，但每次都要重新 list 一次（不是拿旧摘要糊弄）。
    const ok = await enforceToolSnapshot(state)
    assert.equal(ok.ok, true)
    assert.equal(calls, 2, '已经有快照的调用也要重新取一次')

    // 工具集变了：必须拒绝，并标记 changed（调用方据此清 grant）。
    names = ['read', 'write', 'pwsh']
    const changed = await enforceToolSnapshot(state)
    assert.equal(changed.ok, false)
    assert.equal(changed.changed, true)
    assert.match(changed.reason, /工具集在授权后发生了变化/)

    // 读不到工具表：同样作废，不许"读不到就放行"。
    mode = 'throw'
    const broken = await enforceToolSnapshot(state)
    assert.equal(broken.ok, false)
    assert.equal(broken.changed, true)
    assert.match(broken.reason, /工具集无法确认/)

    // 空表也不可信。
    mode = 'ok'
    names = []
    const empty = await enforceToolSnapshot(state)
    assert.equal(empty.ok, false)
    assert.equal(empty.changed, true)
  } finally {
    __test.setHostContext(null)
  }
})
