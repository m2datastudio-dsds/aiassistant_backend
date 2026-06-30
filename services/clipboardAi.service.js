const { generateAssistantReply } = require('../utils/aiClient');
const { classifyClipboardText, normalizeClipboardText, suggestionMap } = require('../utils/clipboardClassifier');

function actionMeta(label) {
  const map = {
    'Create Reminder': { action: 'create_reminder', icon: 'notifications', target: 'reminders' },
    'Add to Calendar': { action: 'add_calendar', icon: 'calendar_month', target: 'calendar' },
    'Save to Vault': { action: 'save_vault', icon: 'inventory_2', target: 'vault' },
    'Open Link': { action: 'open_link', icon: 'open_in_new', target: 'external' },
    'Summarize Website': { action: 'summarize_website', icon: 'article', target: 'chat' },
    'Explain Code': { action: 'explain_code', icon: 'code', target: 'chat' },
    'Optimize Code': { action: 'optimize_code', icon: 'auto_fix_high', target: 'chat' },
    'Save Snippet': { action: 'save_snippet', icon: 'data_object', target: 'vault' },
    'Open Maps': { action: 'open_maps', icon: 'map', target: 'maps' },
    'Save Location': { action: 'save_location', icon: 'place', target: 'vault' },
    Navigate: { action: 'navigate', icon: 'near_me', target: 'maps' },
    'Generate Reply': { action: 'generate_reply', icon: 'reply', target: 'email' },
    Summarize: { action: 'summarize', icon: 'summarize', target: 'chat' },
    'Mark Important': { action: 'mark_important', icon: 'priority_high', target: 'email' },
    'Call Number': { action: 'call_number', icon: 'phone', target: 'phone' },
    'Save Contact': { action: 'save_contact', icon: 'person_add', target: 'contacts' },
    'Ask AI': { action: 'ask_ai', icon: 'auto_awesome', target: 'chat' }
  };
  return { label, ...(map[label] || { action: label.toLowerCase().replace(/\s+/g, '_'), icon: 'auto_awesome', target: 'chat' }) };
}

function buildPreview(text) {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length > 180 ? `${singleLine.slice(0, 180)}...` : singleLine;
}

function buildHeadline(type) {
  const headlines = {
    url: 'This looks like a link you can open, summarize, or save.',
    email: 'This looks like message or email content ready for reply help.',
    phone: 'This looks like a phone number you may want to save or call.',
    location: 'This looks like an address or location you can map.',
    task: 'This looks like a task or schedule item.',
    code: 'This looks like code that AI can explain or improve.',
    note: 'This looks like a note worth summarizing or saving.',
    general: 'This copied text is ready for quick AI help.'
  };
  return headlines[type] || headlines.general;
}

function cleanSuggestionLabels(labels, fallbackType) {
  const fallback = suggestionMap[fallbackType] || suggestionMap.general;
  const merged = Array.isArray(labels) ? labels : [];
  const clean = [...merged, ...fallback]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item, index, arr) => arr.findIndex((other) => other.toLowerCase() === item.toLowerCase()) === index)
    .slice(0, 5);
  return clean.length ? clean : fallback;
}

async function maybeRefineWithAi({ text, base }) {
  try {
    const raw = await generateAssistantReply({
      messages: [
        {
          role: 'system',
          content: [
            'You classify copied clipboard content for a mobile AI assistant.',
            'Return strict JSON only with keys: type, headline, suggestions.',
            'type must be one of: url, email, phone, location, task, code, note, general.',
            'suggestions must be 3 to 5 concise action labels. No markdown.'
          ].join(' ')
        },
        { role: 'user', content: `Clipboard text:\n${text}` }
      ]
    });
    const parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim());
    const allowedTypes = new Set(Object.keys(suggestionMap));
    const type = allowedTypes.has(parsed.type) ? parsed.type : base.type;
    return {
      type,
      headline: String(parsed.headline || buildHeadline(type)).slice(0, 180),
      suggestions: cleanSuggestionLabels(parsed.suggestions, type),
      aiRefined: true
    };
  } catch (_) {
    return null;
  }
}

async function analyzeClipboardText({ text }) {
  const cleanText = normalizeClipboardText(text);
  const base = classifyClipboardText(cleanText);
  const ai = await maybeRefineWithAi({ text: cleanText, base });
  const type = ai?.type || base.type;
  const suggestionLabels = cleanSuggestionLabels(ai?.suggestions || base.suggestions, type);

  return {
    type,
    confidence: base.confidence,
    headline: ai?.headline || buildHeadline(type),
    preview: buildPreview(cleanText),
    suggestions: suggestionLabels,
    actions: suggestionLabels.map(actionMeta),
    signals: base.signals,
    aiRefined: Boolean(ai?.aiRefined)
  };
}

module.exports = { analyzeClipboardText };