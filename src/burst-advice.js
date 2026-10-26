// Per-conversation, in-memory advice; acknowledgement and persisted state stay separate.
export function startBurstAdvice(st, pick) {
  const seenSeq = st.burstAdvice?.seenSeq ?? 0;
  st.burstAdvice = { count: pick(), seenSeq, replied: false };
  return st.burstAdvice.count;
}

// Call only with the incoming messages this response actually offers to the model.
// Supplements before a reply share advice, even across paging and quiet-window reads.
export function observeBurstAdvice(st, messages, pick) {
  let newestSeq = 0;
  for (const message of messages ?? []) {
    if (!message?.isSelf && Number.isSafeInteger(message?.seq) && message.seq > newestSeq) {
      newestSeq = message.seq;
    }
  }
  if (newestSeq <= (st.burstAdvice?.seenSeq ?? 0)) return undefined;
  if (!st.burstAdvice || st.burstAdvice.replied) startBurstAdvice(st, pick);
  st.burstAdvice.seenSeq = newestSeq;
  return st.burstAdvice.count;
}

// The caller records actual nonempty sends, including a partially successful send.
export function markBurstReplied(st) {
  if (st.burstAdvice) st.burstAdvice.replied = true;
}
