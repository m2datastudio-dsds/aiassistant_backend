const URL_RE = /https?:\/\/[^\s]+|www\.[^\s]+/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{3,5}\)?[\s-]?)?\d{3,5}[\s-]?\d{4}/;
const TIME_TASK_RE = /\b(today|tomorrow|tonight|morning|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|deadline|meeting|call|submit|remind|appointment|schedule|due)\b/i;
const ADDRESS_RE = /\b(street|st\.?|road|rd\.?|avenue|ave\.?|lane|ln\.?|nagar|city|near|opposite|behind|block|floor|apartment|apt|pin|pincode|zip|landmark|chennai|bangalore|mumbai|delhi|coimbatore)\b/i;
const CODE_RE = /(```|function\s+\w+|class\s+\w+|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|import\s+.+from|#include\s*<|public\s+class|def\s+\w+|SELECT\s+.+FROM|<\/?[a-z][\s\S]*>)/i;
const EMAIL_CONTENT_RE = /\b(subject:|dear\s+|hello\s+|hi\s+|regards|thanks,|sincerely|forwarded message|from:|to:)\b/i;
const NOTE_RE = /\n|\b(note|idea|summary|remember|important|points|draft)\b/i;

const suggestionMap = {
  url: ['Open Link', 'Summarize Website', 'Save to Vault'],
  email: ['Generate Reply', 'Summarize', 'Mark Important'],
  phone: ['Call Number', 'Save Contact', 'Save to Vault'],
  location: ['Open Maps', 'Save Location', 'Navigate'],
  task: ['Create Reminder', 'Add to Calendar', 'Save to Vault'],
  code: ['Explain Code', 'Optimize Code', 'Save Snippet'],
  note: ['Summarize', 'Save to Vault', 'Ask AI'],
  general: ['Ask AI', 'Summarize', 'Save to Vault']
};

function normalizeClipboardText(text) {
  return String(text || '').replace(/\u0000/g, '').trim().slice(0, 6000);
}

function classifyClipboardText(rawText) {
  const text = normalizeClipboardText(rawText);
  const signals = {
    hasUrl: URL_RE.test(text),
    hasEmailAddress: EMAIL_RE.test(text),
    hasPhone: PHONE_RE.test(text),
    hasTask: TIME_TASK_RE.test(text),
    hasAddress: ADDRESS_RE.test(text),
    hasCode: CODE_RE.test(text),
    hasEmailContent: EMAIL_CONTENT_RE.test(text),
    hasNote: NOTE_RE.test(text)
  };

  let type = 'general';
  if (signals.hasCode) type = 'code';
  else if (signals.hasUrl) type = 'url';
  else if (signals.hasEmailContent || (signals.hasEmailAddress && text.length > 45)) type = 'email';
  else if (signals.hasTask) type = 'task';
  else if (signals.hasAddress) type = 'location';
  else if (signals.hasPhone) type = 'phone';
  else if (signals.hasNote || text.length > 120) type = 'note';

  return {
    type,
    confidence: type === 'general' ? 0.52 : 0.82,
    signals,
    suggestions: suggestionMap[type] || suggestionMap.general
  };
}

module.exports = {
  classifyClipboardText,
  normalizeClipboardText,
  suggestionMap
};