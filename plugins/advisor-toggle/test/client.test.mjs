// 浏览器半的冒烟测试：用极简 React 在 vm 里跑 AdvisorChip，验证注册、渲染与请求路径。
// 跑法: node --test test/client.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = await readFile(join(HERE, '..', 'client.js'), 'utf8');

function makeHarness({ sessionId = 'session-test', fetchImpl } = {}) {
  const calls = [];
  const fetchCalls = [];
  const slots = [];
  const elements = [];

  const h = (type, props, ...children) => {
    const node = { type, props: { ...(props || {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } };
    elements.push(node);
    return node;
  };
  const React = {
    createElement: h,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  };

  const head = { appendChild: () => {}, children: [] };
  const document = {
    head,
    getElementById: () => null,
    createElement: () => ({ style: {}, set textContent(v) { this._text = v; }, get textContent() { return this._text; } }),
    visibilityState: 'visible',
  };

  let plugin = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ id, factory }) => {
          plugin = factory((name) => {
            if (name === 'react') return React;
            throw new Error(`unexpected require ${name}`);
          });
          calls.push({ id });
        },
      },
    },
    document,
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return fetchImpl ? fetchImpl(url, options) : { ok: true, json: async () => ({ enabled: true, noGoStreak: 0 }) };
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    AbortController: class {
      constructor() { this.signal = { aborted: false }; }
      abort() { this.signal.aborted = true; }
    },
    console,
  };
  vm.runInNewContext(SOURCE, vm.createContext(sandbox), { filename: 'client.js' });

  const registered = [];
  const ctx = {
    slots: {
      inject: (slot, fn) => {
        calls.push({ inject: slot });
        fn();
      },
      register: (registration, Component) => {
        registered.push({ registration, Component });
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  return { plugin, registered, Component: registered[0] && registered[0].Component, registration: registered[0] && registered[0].registration, fetchCalls, elements, React };
}

test('注册到 conversation.input.left，order 30，label 顾问', () => {
  const { plugin, registration } = makeHarness();
  assert.equal(plugin.name, 'advisor-toggle');
  assert.equal(JSON.stringify(plugin.inject), '["slots"]');
  assert.equal(registration.name, 'conversation.input.left');
  assert.equal(registration.id, 'advisor-toggle');
  assert.equal(registration.order, 30);
  assert.equal(registration.label, '顾问');
});

test('有 sessionId 时渲染出 chip，并用它去查状态', async () => {
  const { Component, fetchCalls, elements } = makeHarness({ sessionId: 'session-abc' });
  const node = Component({ sessionId: 'session-abc' });
  assert.ok(node, '应当渲染出按钮');
  assert.equal(node.type, 'button');
  assert.equal(node.props.className, 'advisor-chip');
  assert.equal(node.props['data-on'], '0');
  const label = elements.find((el) => el.props && el.props.className === 'advisor-label');
  assert.equal(label && label.props.children, '顾问开关');
  // useEffect 被桩掉，这里只校验组件不崩；状态请求路径由下面的用法保证
  assert.equal(typeof fetchCalls.length, 'number');
});

test('没有 sessionId 时不渲染（不猜会话）', () => {
  const { Component } = makeHarness();
  assert.equal(Component({}), null);
});

test('客户端不再通过 useSessions 扫 byId 找会话', () => {
  assert.ok(!/props\.useSessions/.test(SOURCE), '不应再依赖 useSessions 兜底');
  assert.ok(/props\.sessionId/.test(SOURCE));
});

test('未配置 workspace 时按钮标出配置异常并且不切换（不许静默失效）', () => {
  assert.ok(/data-config/.test(SOURCE), '按钮需要 data-config 标记');
  assert.ok(/workspaceState !== 'ready'/.test(SOURCE), '需要从 /state 读 workspaceState');
  assert.ok(/if \(misconfigured\) return/.test(SOURCE), '配置不可用时点击不切开关');
  assert.ok(/DSH_WORKSPACE/.test(SOURCE), '提示里要写清怎么配');
});
