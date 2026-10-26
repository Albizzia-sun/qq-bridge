import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSummaryPrompt,
  buildProfilePrompt,
  formatMemoryForPrompt,
  formatProfileForPrompt,
  parseSummaryBatch,
  parseProfileReply
} from '../src/long-memory.js';

test('摘要提示以事实和自述为依据，保留否认纠正而不把它解释成性格', () => {
  const correction = '不是不愿交流，我只是今天需要独处。';
  const prompt = buildSummaryPrompt({
    transcript: `对方(测试成员): ${correction}`,
    existing: [{ summary: '测试成员不愿交流。' }], maxEntryChars: 123
  });
  assert.ok(prompt.includes(correction));
  assert.match(prompt, /可核对的事实.*明确自述/);
  assert.match(prompt, /明确否认.*纠正.*优先保留/);
  assert.match(prompt, /不得把.*否认.*纠正.*性格/);
  assert.doesNotMatch(prompt, /他腰疼还嘴硬/);
  assert.match(prompt, /不虚构.*默契.*事件/);
  assert.ok(prompt.includes('最多 3 条'));
  assert.ok(prompt.includes('不超过 123 字'));
  assert.ok(prompt.includes('{"memories":[{"summary":"一句话","tags":["标签"]}]}'));
  assert.ok(prompt.includes('{"memories":[]}'));
});

test('画像提示保留记忆记录时间，并将旧画像和单次观察限制为待核对材料', () => {
  const prompt = buildProfilePrompt({
    existing: '测试旧画像：不愿交流。',
    memories: [
      { t: '2026-10-22 18:00:00', summary: '昨天表示想独处。' },
      { time: '2026-10-23 09:00:00', summary: '今天表示愿意一起讨论。' }
    ],
    impressions: [{ target: '测试成员', content: '一次谈话中话少。' }],
    maxChars: 321
  });
  assert.ok(prompt.includes('测试旧画像：不愿交流。'));
  assert.ok(prompt.includes('2026-10-22 18:00:00'));
  assert.ok(prompt.includes('2026-10-23 09:00:00'));
  assert.match(prompt, /记录时间.*不等于.*发生时间/);
  assert.match(prompt, /旧画像不是独立证据/);
  assert.match(prompt, /单次.*(?:观察|情绪).*稳定性格/);
  assert.match(prompt, /无新证据.*(?:补充|扩写|补写)/);
  assert.doesNotMatch(prompt, /你们之间的默契|语气是「我了解他」/);
  assert.ok(prompt.includes('不超过 321 字'));
  assert.ok(prompt.includes('不要 JSON'));
});

test('画像接收精确纠正材料，并阻止旧摘要或旧画像复活已被否定的内容', () => {
  const prompt = buildProfilePrompt({
    existing: '测试成员不愿交流。',
    memories: [{ summary: '测试成员不愿交流。' }],
    corrections: [{ target: '测试成员', oldContent: '不愿交流', content: '只是今天需要独处，愿意正常交流' }]
  });
  assert.match(prompt, /【明确纠正】/);
  assert.ok(prompt.includes('测试成员'));
  assert.ok(prompt.includes('被纠正原文：不愿交流'));
  assert.ok(prompt.includes('纠正为：只是今天需要独处，愿意正常交流'));
  assert.match(prompt, /明确纠正.*优先/);
  assert.match(prompt, /旧摘要.*旧画像.*已被否定.*(?:恢复|复活)/);
  assert.match(prompt, /不虚构.*默契.*事件/);
});

test('长期条目和画像注入都要求当前明确表达和纠正优先，旧印象不得否定当前', () => {
  const outputs = [
    formatMemoryForPrompt([{ t: '2026-10-22', summary: '测试历史观察' }]),
    formatProfileForPrompt({ text: '测试历史画像' })
  ];
  for (const text of outputs) {
    assert.match(text, /当前明确表达.*纠正.*优先/);
    assert.match(text, /旧印象.*不得.*否定当前/);
  }
  assert.equal(formatMemoryForPrompt([]), '');
  assert.equal(formatProfileForPrompt({ text: '' }), '');
});

test('空纠正正文表示撤回，画像材料保留被撤回原文且不推断反面事实', () => {
  const prompt = buildProfilePrompt({
    corrections: [{ target: '测试成员', oldContent: '不喜欢讨论', content: '' }]
  });
  assert.ok(prompt.includes('被纠正原文：不喜欢讨论'));
  assert.match(prompt, /已撤回/);
  assert.match(prompt, /不.*推断相反事实/);
  assert.ok(!prompt.includes('纠正为：喜欢讨论'));
});

test('旧画像正文为空时仍注入全部纠正撤回材料，并标明旧引文不再是事实', () => {
  const longCorrection = '纠正依据'.repeat(100) + '纠正末尾标记';
  const corrections = [
    { target: '测试成员', oldContent: '旧判断', content: longCorrection },
    { target: '测试成员', oldContent: '更早判断', content: '' }
  ];
  const text = formatProfileForPrompt({ text: '', corrections }, { maxChars: 200 });
  assert.match(text, /已明确纠正\/撤回/);
  assert.match(text, /优先于旧摘要/);
  assert.match(text, /引用的旧原文已撤销，不是当前事实/);
  assert.match(text, /多次纠正以最后一次与当前印象为准/);
  assert.ok(text.includes(longCorrection));
  assert.ok(text.indexOf('旧判断') < text.indexOf('更早判断'));
  assert.match(text, /已撤回/);
  assert.match(text, /不.*推断相反事实/);
  assert.ok(!text.includes('【你对他这个人的了解】'));
});

test('有画像正文时保留原正文预算，并完整附带纠正材料', () => {
  const profile = { text: '甲'.repeat(1000) };
  const original = formatProfileForPrompt(profile, { maxChars: 400 });
  const corrected = formatProfileForPrompt({
    ...profile, corrections: [{ target: '测试成员', oldContent: '旧原文', content: '明确新内容' }]
  }, { maxChars: 400 });
  assert.ok(corrected.startsWith(original));
  assert.ok(corrected.includes('被纠正原文：旧原文'));
  assert.ok(corrected.includes('纠正为：明确新内容'));
});

test('新增材料保持原默认调用、摘要协议、近20条材料和输出字符限制', () => {
  assert.doesNotThrow(() => buildSummaryPrompt());
  assert.doesNotThrow(() => buildProfilePrompt());
  const memories = Array.from({ length: 21 }, (_, i) => ({ summary: `材料-${String(i).padStart(2, '0')}-结束` }));
  const prompt = buildProfilePrompt({ memories });
  assert.ok(!prompt.includes('材料-00-结束'));
  assert.ok(prompt.includes('材料-01-结束'));
  assert.ok(prompt.includes('材料-20-结束'));
  assert.deepEqual(parseSummaryBatch('{"memories":[{"summary":"正常摘要","tags":[]}]}'), {
    memories: [{ summary: '正常摘要', tags: [] }]
  });
  assert.equal(parseProfileReply('甲'.repeat(401)).length, 400);
  assert.ok(formatProfileForPrompt({ text: '甲'.repeat(1000) }, { maxChars: 400 }).length <= 402);
  assert.ok(formatMemoryForPrompt([{ summary: '甲'.repeat(1000) }], { maxChars: 500 }).length <= 502);
});
