import assert from 'node:assert/strict';
import test from 'node:test';
import * as memory from '../src/long-memory.js';

function parser() {
  assert.equal(typeof memory.parseSummaryBatch, 'function', '必须导出实际批量解析函数');
  return memory.parseSummaryBatch;
}

test('实际提取提示词声明 memories 数组协议及合法空数组，保留已有材料', () => {
  const prompt = memory.buildSummaryPrompt({
    transcript: '测试成员：周六一起拍照', existing: [{ summary: '喜欢摄影' }], maxEntryChars: 123
  });
  assert.ok(prompt.includes('{"memories":[{"summary":"一句话","tags":["标签"]}]}'));
  assert.ok(prompt.includes('{"memories":[]}'));
  assert.ok(prompt.includes('最多 3 条'));
  assert.ok(prompt.includes('不超过 123 字'));
  assert.ok(prompt.includes('测试成员：周六一起拍照'));
  assert.ok(prompt.includes('喜欢摄影'));
  assert.doesNotMatch(prompt, /summary 返回空字符串|summary 为空时用/);
});

for (const count of [0, 1, 3]) {
  test(`正式协议解析 ${count} 条，逐项保留摘要和标签`, () => {
    const memories = Array.from({ length: count }, (_, i) => ({ summary: `摘要${i}`, tags: [`标签${i}`] }));
    assert.deepEqual(parser()(JSON.stringify({ memories })), { memories });
  });
}

test('兼容旧单对象协议，旧空 summary 明确表示合法空结果', () => {
  const parse = parser();
  assert.deepEqual(parse('{"summary":"旧摘要","tags":["旧标签"]}'), {
    memories: [{ summary: '旧摘要', tags: ['旧标签'] }]
  });
  assert.deepEqual(parse('{"summary":""}'), { memories: [] });
  assert.deepEqual(parse('{"summary":"   ","tags":[]}'), { memories: [] });
  assert.deepEqual(parse('{"summary":"无标签摘要"}'), { memories: [{ summary: '无标签摘要', tags: [] }] });
});

test('容忍代码围栏与前后文字，不改变有效结果', () => {
  const parse = parser();
  const result = { memories: [{ summary: '喜欢摄影', tags: ['爱好'] }] };
  for (const text of [
    `\`\`\`json\n${JSON.stringify(result)}\n\`\`\``,
    `提取结果如下：\n${JSON.stringify(result)}\n以上是值得记住的内容。`
  ]) assert.deepEqual(parse(text), result);
});

test('新批量解析沿用既有摘要长度和标签归一化', () => {
  assert.deepEqual(parser()(JSON.stringify({ memories: [{
    summary: '  abc\n def ghi ', tags: ['  标签一  ', '', '标签\n二', '三', '四', '五']
  }] }), 7), { memories: [{ summary: 'abc def', tags: ['标签一', '标签 二', '三', '四'] }] });
});

test('非法 JSON、非法结构与非法条目均抛错，不伪装成合法空结果', () => {
  const parse = parser();
  const invalid = [
    '', '不是 JSON', '{"memories":[}', '{"memories":[],}', 'null', '[]',
    '[{"summary":"数组根对象不能当成旧协议"}]', '{}', '{"unrelated":[]}',
    '{"memories":null}', '{"memories":{}}', '{"memories":""}',
    '{"memories":null,"summary":"不能回退旧协议"}',
    '{"memories":["不是条目对象"]}', '{"memories":[null]}',
    '{"memories":[{}]}', '{"memories":[{"summary":4}]}',
    '{"memories":[{"summary":""}]}', '{"memories":[{"summary":"  "}]}',
    '{"memories":[{"summary":"有效","tags":null}]}',
    '{"memories":[{"summary":"有效","tags":"错误类型"}]}',
    '{"memories":[{"summary":"有效","tags":[1]}]}',
    '{"summary":null}', '{"summary":false}', '{"summary":"","tags":{}}',
    JSON.stringify({ memories: Array.from({ length: 4 }, () => ({ summary: '超过三条', tags: [] })) })
  ];
  for (const text of invalid) assert.throws(() => parse(text), Error, `非法输入必须失败：${text}`);
});

test('旧 parseSummaryReply export 的既有行为保留', () => {
  assert.deepEqual(memory.parseSummaryReply(JSON.stringify({ summary: '  旧\n摘要 ', tags: [' x ', 2] })), {
    summary: '旧 摘要', tags: ['x', '2']
  });
  assert.deepEqual(memory.parseSummaryReply('非法 JSON'), { summary: '', tags: [] });
});
