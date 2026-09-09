// AutoChatbot - History crawler direction-resolution logic.
//
// Mirrors (and must be kept in sync with) the literal copy inlined inside the
// chrome.scripting.executeScript closure in background.js
// (handleSyncThreadMessages -> allRows.forEach). That closure is injected
// into the Facebook tab and cannot require() this file, so this exists to
// make the decision logic testable in isolation - same duplication pattern
// as textFilter.js / historySyncRoundBudget.js.

(function () {
  const SELF_SENT_PATTERN = /do Bạn gửi|Tin nhắn do Bạn gửi lúc|Bạn đã gửi|sent by you|You sent|Message sent by you/i;
  const OLD_NAME_PATTERN_1 = /Tin nhắn do ([^]+?) gửi lúc/i;
  const OLD_NAME_PATTERN_2 = /Message sent by ([^]+?) at/i;
  const SELF_NAME_PATTERN = /^(?:Bạn|You)$/i;
  // First segment is greedy (not `.+?`) so it consumes through any commas
  // embedded in the date portion ("29 Tháng 3, 2025,") and only backtracks to
  // the LAST comma before the name - a non-greedy first segment stops at the
  // FIRST comma instead, folding "2025, " into the captured name.
  const NEW_LABEL_PATTERN = /^Lúc\s+.+,\s*(.+?):\s*/i;

  // Returns { matched: false } when direction genuinely cannot be determined -
  // callers MUST skip the message rather than defaulting to incoming/outgoing,
  // since a wrong direction can make AutoReplyEngine/AIMediator answer the
  // business's own outbound message as if it were the customer asking.
  function resolveDirectionFromLabel(effectiveLabel, contactName) {
    if (!effectiveLabel) return { matched: false };

    if (SELF_SENT_PATTERN.test(effectiveLabel)) {
      return { matched: true, isOutgoing: true, senderName: 'Bạn' };
    }

    const oldNameMatch = effectiveLabel.match(OLD_NAME_PATTERN_1) || effectiveLabel.match(OLD_NAME_PATTERN_2);
    if (oldNameMatch) {
      const rawSender = oldNameMatch[1].trim();
      if (SELF_NAME_PATTERN.test(rawSender)) {
        return { matched: true, isOutgoing: true, senderName: 'Bạn' };
      }
      return { matched: true, isOutgoing: false, senderName: rawSender };
    }

    const newLabelMatch = effectiveLabel.match(NEW_LABEL_PATTERN);
    if (newLabelMatch) {
      const rawSender = newLabelMatch[1].trim();
      if (contactName && rawSender.toLowerCase() === String(contactName).trim().toLowerCase()) {
        return { matched: true, isOutgoing: false, senderName: rawSender };
      }
      if (contactName) {
        // Thread 1-1 only has two sides - a name that isn't the contact must be us.
        return { matched: true, isOutgoing: true, senderName: 'Bạn' };
      }
      return { matched: false };
    }

    return { matched: false };
  }

  globalThis.FbCrmHistoryRowSupport = { resolveDirectionFromLabel };
})();
