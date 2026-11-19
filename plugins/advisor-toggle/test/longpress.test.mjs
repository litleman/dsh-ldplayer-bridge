// 长按应急出口的回归测试：复现 2026-11-18 现场「override 之后 0.5 秒被 click 重新打开」。
// 跑法: node --test test/longpress.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
// 允许指向别的副本，用于「红/绿」验证：同一份测试跑在修复前代码上必须失败。
const SOURCE = await readFile(
  process.env.ADVISOR_CLIENT_SOURCE || join(HERE, '..', 'client.js'),
  'utf8',
);

function makeHarness({ enabled = true } = {}) {
  const posts = [];
  const timers = new Map();
  let nextTimer = 1;
  const listeners = new Map();
  const hookState = [];
  const hookRefs = [];
  const effects = [];
  const ranEffects = new Set();
  let cursor = 0;
  let dirty = false;
  let Component = null;
  let tree = null;

  const h = (type, props, ...children) => ({
    type,
    props: {
      ...(props || {}),
      ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}),
    },
  });

  const React = {
    createElement: h,
    useState: (init) => {
      const i = cursor++;
      if (!(i in hookState)) hookState[i] = { value: typeof init === 'function' ? init() : init };
      const slot = hookState[i];
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next;
          dirty = true;
        },
      ];
    },
    useRef: (value) => {
      const i = cursor++;
      if (!(i in hookRefs)) hookRefs[i] = { current: value };
      return hookRefs[i];
    },
    useCallback: (fn) => fn,
    useEffect: (fn) => {
      const i = cursor++;
      effects[i] = fn;
    },
  };

  const document = {
    head: { appendChild: () => {}, children: [] },
    getElementById: () => null,
    createElement: () => ({ style: {}, textContent: '' }),
    visibilityState: 'visible',
  };

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ factory }) => {
          const plugin = factory((name) => {
            if (name === 'react') return React;
            throw new Error(`unexpected require ${name}`);
          });
          Component = plugin;
          // 直接拿注册进槽的组件
          plugin.apply({
            slots: {
              inject: (_slot, fn) => fn(),
              register: (_registration, component) => {
                Component = component;
                return () => {};
              },
            },
          });
        },
      },
      addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) || []), fn]),
      removeEventListener: (type, fn) => {
        listeners.set(type, (listeners.get(type) || []).filter((item) => item !== fn));
      },
    },
    document,
    fetch: async (url, options = {}) => {
      const method = options.method || 'GET';
      if (method === 'POST') posts.push({ url, body: options.body });
      if (url.includes('/state')) {
        return {
          ok: true,
          json: async () => ({ enabled, noGoStreak: 0, stateVersion: 7, generation: 1, alert: false, workspaceState: 'ready', configError: '', bridgeState: 'ready' }),
        };
      }
      if (url.includes('/override/challenge')) return { ok: true, json: async () => ({ challengeId: 'c1', nonce: 'n1', expiresAt: Date.now() + 30000 }) };
  if (url.includes('/override')) return { ok: true, json: async () => ({ enabled: false, overridden: true }) };
      if (url.includes('/toggle')) return { ok: true, json: async () => ({ enabled: false, stateVersion: 8 }) };
      return { ok: false, json: async () => ({}) };
    },
    setTimeout: (fn) => {
      const id = nextTimer++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    AbortController: class {
      constructor() {
        this.signal = { aborted: false };
      }
      abort() {
        this.signal.aborted = true;
      }
    },
    console,
  };
  vm.runInNewContext(SOURCE, vm.createContext(sandbox), { filename: 'client.js' });

  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  const render = () => {
    cursor = 0;
    dirty = false;
    tree = Component({ sessionId: 'session-lp' });
    effects.forEach((fn, i) => {
      if (ranEffects.has(i) || typeof fn !== 'function') return;
      ranEffects.add(i);
      fn();
    });
    return tree;
  };

  const fireTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach((fn) => fn());
  };

  const fireWindow = (type) => (listeners.get(type) || []).forEach((fn) => fn({ pointerId: 1 }));

  return { render, flush, fireTimers, fireWindow, posts, get tree() { return tree; } };
}

test('长按 3 秒触发 override 后，补发的 click 不会再 toggle 回开', async () => {
  const harness = makeHarness({ enabled: true });
  await harness.flush();
  harness.render(); // 首次渲染：挂上 effect
  await harness.flush(); // refresh() 把 enabled=true 写回状态
  const tree = harness.render(); // 再渲染一次才看得到 data-on="1"
  await harness.flush();

  assert.equal(tree.type, 'button');
  assert.equal(tree.props['data-on'], '1');

  tree.props.onPointerDown({ pointerId: 1 });
  harness.fireTimers(); // 3 秒到点 → POST /override
  await harness.flush();
  harness.fireWindow('pointerup'); // 浏览器补发：长按结束
  tree.props.onClick(); // 浏览器补发：click
  await harness.flush();

  const overrides = harness.posts.filter((post) => /\/override$/.test(post.url));
  const toggles = harness.posts.filter((post) => post.url.includes('/toggle'));
  assert.equal(overrides.length, 1, '长按应当打到 /override');
  assert.equal(
    harness.posts.filter((post) => post.url.includes('/override/challenge')).length >= 1,
    true,
    '长按前必须先领一次性挑战票',
  );
  assert.equal(toggles.length, 0, '长按后的 click 绝不能触发 /toggle（否则开关被弹回）');
});

test('短按（没到 3 秒就松手）仍然是一次普通的开关切换', async () => {
  const harness = makeHarness({ enabled: true });
  await harness.flush();
  harness.render();
  await harness.flush();
  const tree = harness.render();
  await harness.flush();

  tree.props.onPointerDown({ pointerId: 1 });
  harness.fireWindow('pointerup'); // 松手早于 3 秒
  tree.props.onClick();
  await harness.flush();

  const overrides = harness.posts.filter((post) => /\/override$/.test(post.url));
  const toggles = harness.posts.filter((post) => post.url.includes('/toggle'));
  assert.equal(overrides.length, 0, '短按不该触发应急出口');
  assert.equal(toggles.length, 1, '短按仍要能正常开关');
});
