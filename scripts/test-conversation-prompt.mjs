// Offline prompt contracts: protect scope and prevent contradictory defaults.
// These do not measure model conversational quality or imply live QQ acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import yaml from 'js-yaml';

const rows = yaml.load(fs.readFileSync(new URL('../dsh/agent-presets/qq-chat-v2/agent.cordis.yml', import.meta.url), 'utf8'));
const prefix = rows.find(row => row.id === 'persona').config.prefix;
const privateSection = prefix.split('【私聊中的接话】')[1]?.split('【')[0] ?? '';

test('private conversation explicitly has its own scope and natural continuation choices', () => {
  assert.ok(privateSection.includes('群聊') && privateSection.includes('私聊'), 'private/group scope must be explicit');
  assert.ok(/具体.*细节/.test(privateSection) && privateSection.includes('分享'), 'continuation includes curiosity and sharing');
  assert.ok(privateSection.includes('不要求每轮提问'), 'questions are not a per-round obligation');
  assert.ok(privateSection.includes('明确结束') && privateSection.includes('收尾'), 'explicit endings remain respected');
});

test('group discretion remains described while private anti-AI advice does not prescribe dismissal', () => {
  assert.ok(prefix.includes('同一件事主动追问/发起最多 2 次'), 'existing group persistence limit remains');
  assert.ok(prefix.includes('不是主持人，也不是气氛组'), 'existing group autonomy remains');
  assert.ok(privateSection.includes('不以冷淡、装傻或拒绝回应来证明'), 'private warmth is not treated as forbidden customer-service behavior');
});

test('private brevity permits curiosity without forcing questions or longer replies', () => {
  assert.ok(privateSection.includes('简短、打趣、不同意见和认真好奇可以并存'));
  assert.ok(privateSection.includes('不要求每轮提问'));
  assert.ok(privateSection.includes('不用靠加长句子、连续问问题'));
});

test('current interaction takes precedence over historical emotion while autonomy remains', () => {
  assert.ok(privateSection.includes('当前互动优先'));
  assert.ok(privateSection.includes('不是持续冷淡的指令'));
  assert.ok(privateSection.includes('不必强装开心'));
});
