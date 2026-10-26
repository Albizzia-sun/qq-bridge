import { compactTranscript } from './long-memory.js';

/** 只消费完整呈现的最早连续前缀；空白来源保留，首个超长正文独占文本批次。 */
export function buildSummaryTranscriptBatch(messages, { limit = 40, maxChars = 4000 } = {}) {
  const selected = [];
  let transcript = '';
  for (const message of (Array.isArray(messages) ? messages : []).slice(0, Math.max(1, limit))) {
    const candidate = [...selected, message];
    const candidateTranscript = compactTranscript(candidate.map((item) => ({
      ...item, isSelf: item?.role === 'assistant',
    })), { limit: candidate.length, maxChars: Infinity });
    if (transcript && candidateTranscript.length > maxChars) break;
    selected.push(message);
    transcript = candidateTranscript;
    // 首个正文超预算仍须完整交给模型，且不能被前置空白来源阻塞。
    if (transcript.length > maxChars) break;
  }
  return { messages: selected, transcript };
}
