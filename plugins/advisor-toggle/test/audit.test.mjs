// tools/audit.mjs 的加固测试（对应顾问 NO-GO 的 9 条，每个 HIGH 项都要有成功 + 失败用例）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  REDACT_RULES_VERSION,
  DENY_FILES,
  isDeniedPath,
  versionOf,
  redact,
  leftoverSecrets,
  collectMaterials,
  parseReply,
  buildPrompts,
  compact,
  MANIFEST_KEYS,
} from '../tools/audit.mjs';

const mat = (rel, text) => ({ rel, from: 'plugin', text });

// ---------- 1. VERSION 绑真实内容（HIGH-1）----------
test('版本摘要：内容变一个字节，版本必须变（不依赖 git status）', () => {
  const a = versionOf([mat('index.js', 'const x = 1;\n')]);
  const b = versionOf([mat('index.js', 'const x = 2;\n')]);
  assert.equal(a.length, 12);
  assert.notEqual(a, b, '只改内容、不改文件名/状态，版本也必须变化');
});

test('版本摘要：文件集合或相对路径变化也要变', () => {
  const a = versionOf([mat('index.js', 'x')]);
  const b = versionOf([mat('index.js', 'x'), mat('client.js', '')]);
  const c = versionOf([mat('a/index.js', 'x')]);
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('版本摘要：同样输入必须稳定（否则每次评审版本都变）', () => {
  const m = [mat('b.js', 'y'), mat('a.js', 'x')];
  assert.equal(versionOf(m), versionOf([...m].reverse()));
});

// ---------- 2. DENY_FILES 必须真的在收集入口生效（HIGH-6）----------
test('拒绝名单：大小写、相对路径、目录、扩展名都要命中', () => {
  const denied = [
    'D:\\Administrator\\allWorkFiles\\ds-workspace\\雷电bridge\\windows-bridge\\config.json',
    'CONFIG.JSON',
    'plugin/.env',
    'plugin/.env.local',
    'keys/id_rsa',
    'keys/server.pem',
    'certs/a.PFX',
    'secrets',
    'credentials.json',
  ];
  for (const p of denied) assert.equal(isDeniedPath(p), true, `应拒绝: ${p}`);
  const allowed = ['index.js', 'README.md', 'docs/tokens-guide.md', 'src/config.js'];
  for (const p of allowed) assert.equal(isDeniedPath(p), false, `应放行: ${p}`);
});

test('拒绝名单常量本身不为空（防止被静默改空）', () => {
  assert.ok(Array.isArray(DENY_FILES) && DENY_FILES.length >= 4);
});

test('收集入口：命中拒绝名单时直接抛错，不读内容不外发', async () => {
  await assert.rejects(
    () => collectMaterials({ materials: [{ rel: '雷电bridge/windows-bridge/config.json', from: 'ws' }] }),
    /拒绝送审/,
  );
});

// ---------- 3. 脱敏与无状态复检（MED-5/MED-7）----------
test('脱敏：已知 token / JSON 字段 / Bearer / 用户名路径都要处理', () => {
  const token = 'tok-abcdef123456';
  const raw = `const t = "${token}";\n{"apiToken":"sk-secret-000111"}\nAuthorization: Bearer abcdefgh12345\nC:\\Users\\Administrator\\x`;
  const { text, hits } = redact(raw, { knownTokens: [token] });
  assert.ok(!text.includes(token));
  assert.ok(!text.includes('sk-secret-000111'));
  assert.ok(!text.includes('abcdefgh12345'));
  assert.ok(!text.includes('Administrator'));
  assert.ok(hits.some((h) => h.rule === 'known-token'));
  assert.ok(hits.some((h) => h.rule === 'json-secret-field'));
  assert.ok(hits.some((h) => h.rule === 'user-path'));
});

test('脱敏：连调多次结果一致（带 g 正则的 lastIndex 不能泄漏状态）', () => {
  const raw = '{"token":"aaaabbbbcccc"}';
  const one = redact(raw);
  const two = redact(raw);
  const three = redact(raw);
  assert.deepEqual(one, two);
  assert.deepEqual(two, three);
});

test('复检：干净文本返回空数组；残留必须被抓出来', () => {
  assert.deepEqual(leftoverSecrets('const a = 1;'), []);
  assert.deepEqual(leftoverSecrets('{"token":"«REDACTED»"}'), []);
  assert.ok(leftoverSecrets('{"token":"plainsecret"}').includes('json-secret-field'));
  assert.ok(leftoverSecrets('X-DSH-Token: abcdefgh1234').includes('header-x-dsh-token'));
});

test('复检：同一函数反复调用不受上一次结果影响', () => {
  const dirty = '{"token":"zzzzzzzzz"}';
  const clean = 'const a = 1;';
  const first = leftoverSecrets(dirty);
  const second = leftoverSecrets(clean);
  const third = leftoverSecrets(dirty);
  assert.deepEqual(first, third);
  assert.deepEqual(second, []);
});

test('脱敏规则版本号必须写进材料（便于事后追溯用了哪版规则）', () => {
  assert.match(REDACT_RULES_VERSION, /^redact-v\d+$/);
});

// ---------- 4. 清单解析严格（HIGH-2/3/4）----------
const expected = { auditId: 'audit-1', seq: 1, total: 3, version: 'abc123def456', chars: 100 };
const good = [
  'AUDIT_ID: audit-1',
  'SEQ: 1',
  'TOTAL: 3',
  'VERSION: abc123def456',
  'CHARS: 100',
  'VERDICT: NEEDS-WORK',
  '| 1 | HIGH | index.js | 现象 | 建议 |',
].join('\n');

test('解析：合法回复通过，结论取清单之后的那一行', () => {
  const r = parseReply(good, expected);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'NEEDS-WORK');
});

test('解析：换行被吞成一行时仍能解析（真实环境里 ChatGPT 会这样输出）', () => {
  const squashed = good.replace(/\n/g, '');
  const r = parseReply(squashed, expected);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.verdict, 'NEEDS-WORK');
});

test('解析：字段顺序必须严格（HIGH-2 失败用例）', () => {
  const bad = ['SEQ: 1', 'AUDIT_ID: audit-1', 'TOTAL: 3', 'VERSION: abc123def456', 'CHARS: 100', 'VERDICT: PASS'].join('\n');
  const r = parseReply(bad, expected);
  assert.equal(r.ok, false);
  assert.match(r.reason, /manifest-field-SEQ-missing|manifest-order/);
});

test('解析：缺字段/截断必须判 INCOMPLETE（HIGH-3 失败用例）', () => {
  const cut = good.split('\n').slice(0, 4).join('\n'); // 缺 CHARS 与结论
  const r = parseReply(cut, expected);
  assert.equal(r.ok, false);
  assert.match(r.reason, /manifest-field-CHARS-missing|verdict-not-after-manifest/);
  assert.equal(parseReply('', expected).reason, 'empty');
});

test('解析：清单字段与预期不一致必须拒绝（不许"大致对"）', () => {
  for (const [k, v] of [['AUDIT_ID', 'audit-2'], ['SEQ', '2'], ['TOTAL', '9'], ['VERSION', 'ffffffffffff'], ['CHARS', '101']]) {
    const broken = good.replace(new RegExp(`^${k}: .*$`, 'm'), `${k}: ${v}`);
    const r = parseReply(broken, expected);
    assert.equal(r.ok, false, `${k} 不一致必须拒绝`);
    assert.match(r.reason, /manifest-mismatch/);
  }
});

test('解析：正文里再出现 VERDICT（重复或引用）一律 INCOMPLETE（HIGH-4 失败用例）', () => {
  const dup = `${good}\nVERDICT: PASS`;
  const r = parseReply(dup, expected);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'duplicate-verdict');
});

test('解析：结论必须紧跟清单（中间不许夹大段正文）', () => {
  const bad = good.replace('VERDICT: NEEDS-WORK', `${'很长的分析。'.repeat(80)}\nVERDICT: NEEDS-WORK`);
  const r = parseReply(bad, expected);
  assert.equal(r.ok, false);
  assert.match(r.reason, /verdict-not-after-manifest|not-single-token/);
});

test('解析：结论行只认 PASS / NEEDS-WORK，其它一律拒绝', () => {
  const bad = good.replace('VERDICT: NEEDS-WORK', 'VERDICT: GO');
  assert.equal(parseReply(bad, expected).ok, false);
});

test('解析：前导空行不影响（模型常留一行空白），但结论位置仍固定在第六个非空行', () => {
  const r = parseReply(`\n\n${good}`, expected);
  assert.equal(r.ok, true);
});

// ---------- 5. 分包的 CHARS 自指必须正确 ----------
test('分包：每个包的 CHARS 必须等于包体真实字符数', () => {
  const materials = [
    mat('package.json', '{"name":"x"}'),
    mat('index.js', Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join('\n')),
    mat('client.js', 'console.log(1);'),
  ];
  const prompts = buildPrompts(materials, { auditId: 'audit-9', version: 'v123', maxChars: 20000, round: 3 });
  assert.ok(prompts.length >= 3);
  for (const p of prompts) {
    assert.equal(p.chars, p.body.length, `${p.title} 的 CHARS 与实际长度不一致`);
    assert.ok(p.body.includes(`CHARS: ${p.chars}`));
    assert.ok(p.body.includes('AUDIT_ID: audit-9'));
    assert.ok(p.body.includes(`SEQ: ${p.seq}`));
    assert.ok(p.body.includes(`TOTAL: ${p.total}`));
  }
});

test('分包：超过上限必须抛错，而不是悄悄截断', () => {
  const materials = [mat('index.js', Array.from({ length: 200 }, (_, i) => `const long${i} = '${'x'.repeat(80)}';`).join('\n'))];
  assert.throws(() => buildPrompts(materials, { auditId: 'a', version: 'v', maxChars: 2000, round: 3 }), /超过上限/);
});

// ---------- 6. compact 不得改写语义 ----------
test('compact 只删注释与空行，不改代码字符', () => {
  const src = ['// 注释', 'const a = 1;', '', '/* 块注释 */', 'const b = 2; // 尾注'].join('\n');
  const out = compact(src);
  assert.ok(!out.includes('// 注释'));
  assert.ok(out.includes('const a = 1;'));
  assert.ok(out.includes('const b = 2; // 尾注'), '行尾注释属于代码行，保留原样');
});

test('MANIFEST_KEYS 顺序是契约，改动会让历史回复失效', () => {
  assert.deepEqual(MANIFEST_KEYS, ['AUDIT_ID', 'SEQ', 'TOTAL', 'VERSION', 'CHARS']);
});

test('每个送审文件都必须能读并且不带凭据（真实收集一次）', async () => {
  const materials = await collectMaterials();
  assert.ok(materials.length >= 5);
  for (const m of materials) {
    assert.ok(m.chars > 0, `${m.rel} 为空`);
    assert.deepEqual(leftoverSecrets(m.text), [], `${m.rel} 脱敏后仍有残留`);
  }
  const index = materials.find((m) => m.rel === 'index.js');
  assert.ok(index.text.length > 1000, 'index.js 材料太少，说明路径或读取有问题');
  assert.ok(materials.every((m) => !isDeniedPath(join('D:', m.rel))));
});
