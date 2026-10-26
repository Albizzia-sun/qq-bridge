// Pure reply-segment advice tests. No bridge, model, or QQ connection.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startBurstAdvice, observeBurstAdvice, markBurstReplied } from '../src/burst-advice.js';

function picker(...counts) {
  let calls = 0;
  return {
    pick: () => counts[calls++],
    get calls() { return calls; },
  };
}

test('a real new wake draws once and preserves the previous visibility watermark', () => {
  const st = { burstAdvice: { count: 1, seenSeq: 7, replied: true } };
  const p = picker(4);
  assert.equal(startBurstAdvice(st, p.pick), 4);
  assert.deepEqual(st.burstAdvice, { count: 4, seenSeq: 7, replied: false });
  assert.equal(observeBurstAdvice(st, [{ seq: 7 }], p.pick), undefined);
  assert.equal(p.calls, 1);
});

test('first visible incoming messages start advice without requiring a wake', () => {
  const st = {};
  const p = picker(3);
  assert.equal(observeBurstAdvice(st, [{ seq: 1 }, { seq: 2 }], p.pick), 3);
  assert.deepEqual(st.burstAdvice, { count: 3, seenSeq: 2, replied: false });
  assert.equal(p.calls, 1);
});

test('supplements before a reply keep the same advice across different reads', () => {
  const st = {};
  const p = picker(4);
  assert.equal(startBurstAdvice(st, p.pick), 4);
  assert.equal(observeBurstAdvice(st, [{ seq: 1 }, { seq: 2 }], p.pick), 4);
  assert.equal(observeBurstAdvice(st, [{ seq: 2 }, { seq: 3 }], p.pick), 4);
  assert.equal(observeBurstAdvice(st, [{ seq: 4 }], p.pick), 4);
  assert.equal(p.calls, 1);
  assert.equal(st.burstAdvice.seenSeq, 4);
});

test('a reply followed by newly visible incoming messages draws once for the next segment', () => {
  const st = {};
  const p = picker(1, 4);
  assert.equal(observeBurstAdvice(st, [{ seq: 1 }], p.pick), 1);
  markBurstReplied(st);
  assert.equal(observeBurstAdvice(st, [{ seq: 1 }], p.pick), undefined);
  assert.equal(st.burstAdvice.replied, true);
  assert.equal(observeBurstAdvice(st, [{ seq: 2 }, { seq: 3 }], p.pick), 4);
  assert.equal(observeBurstAdvice(st, [{ seq: 3 }], p.pick), undefined);
  assert.equal(observeBurstAdvice(st, [{ seq: 4 }], p.pick), 4);
  assert.deepEqual(st.burstAdvice, { count: 4, seenSeq: 4, replied: false });
  assert.equal(p.calls, 2);
});

test('empty timeouts, self messages, invalid sequences and older history never draw', () => {
  const st = {};
  const p = picker(2);
  const ignored = [null, { seq: 0 }, { seq: -1 }, { seq: 1.5 }, { seq: '2' },
    { seq: Number.MAX_SAFE_INTEGER + 1 }, { seq: 100, isSelf: true }];
  for (const messages of [[], undefined, ignored]) {
    assert.equal(observeBurstAdvice(st, messages, p.pick), undefined);
  }
  markBurstReplied(st);
  assert.equal(Object.hasOwn(st, 'burstAdvice'), false);
  assert.equal(p.calls, 0);
  observeBurstAdvice(st, [{ seq: 5 }], p.pick);
  markBurstReplied(st);
  for (const messages of [[], [{ seq: 1 }, { seq: 5 }], [{ seq: 6, isSelf: true }]]) {
    assert.equal(observeBurstAdvice(st, messages, p.pick), undefined);
  }
  assert.deepEqual(st.burstAdvice, { count: 2, seenSeq: 5, replied: true });
  assert.equal(p.calls, 1);
});

test('disabled advice is cached rather than redrawn for every supplement', () => {
  const st = {};
  const p = picker(null, null);
  assert.equal(startBurstAdvice(st, p.pick), null);
  assert.equal(observeBurstAdvice(st, [{ seq: 1 }], p.pick), null);
  assert.equal(observeBurstAdvice(st, [{ seq: 2 }], p.pick), null);
  assert.equal(p.calls, 1);
  markBurstReplied(st);
  assert.equal(observeBurstAdvice(st, [{ seq: 3 }], p.pick), null);
  assert.equal(p.calls, 2);
});

test('advice stays isolated by conversation and does not alter acknowledgement receipts', () => {
  const seen = new Set([1]);
  const first = { modelSeenSeqs: seen, lastReadThroughSeq: 1 };
  const second = {};
  const p = picker(2, 4, 1);
  assert.equal(observeBurstAdvice(first, [{ seq: 2 }], p.pick), 2);
  assert.equal(observeBurstAdvice(second, [{ seq: 2 }], p.pick), 4);
  markBurstReplied(first);
  assert.equal(observeBurstAdvice(first, [{ seq: 3 }], p.pick), 1);
  assert.deepEqual(second.burstAdvice, { count: 4, seenSeq: 2, replied: false });
  assert.equal(first.modelSeenSeqs, seen);
  assert.deepEqual([...seen], [1]);
  assert.equal(first.lastReadThroughSeq, 1);
});
