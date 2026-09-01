// Answer normalization — faithful port of PAMELA stats/01-normalize.js (MIT,
// Zenodo 21278793). Same regexes, same canonical forms, so probe answers are
// comparable with the published reference distributions.
//
// normalizeAnswer(raw, taskId, lang) -> { normalized: string|null, answerClass }

const AR_DIGITS = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
  '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};
const ZH_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

const REFUSAL_RE = /(i can.?t|i cannot|i'm sorry|as an ai|не могу|извин|抱歉|无法|لا أستطيع|عذراً|آسف)/i;

const COIN = {
  en: { heads: 'h', tails: 't' },
  ru: { 'орёл': 'h', 'орел': 'h', 'решка': 't' },
  zh: { '正面': 'h', '正': 'h', '反面': 't', '反': 't' },
  ar: { 'صورة': 'h', 'كتابة': 't' },
};

function zhNumber(s) {
  const m = s.match(/^([零一二两三四五六七八九])?十?([零一二两三四五六七八九])?$/);
  if (!m || (!m[1] && !m[2] && !s.includes('十'))) return null;
  if (!s.includes('十')) return m[1] ? ZH_DIGITS[m[1]] : null;
  return (m[1] ? ZH_DIGITS[m[1]] : 1) * 10 + (m[2] ? ZH_DIGITS[m[2]] : 0);
}

function basicClean(raw) {
  return raw
    .normalize('NFC')
    .replace(/[«»"“”„'’‘`().,!?。！？、：:;؛؟\[\]{}*_#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeAnswer(raw, task, lang) {
  if (raw == null || !String(raw).trim()) return { normalized: null, answerClass: 'empty' };
  const rawStr = String(raw);
  if (REFUSAL_RE.test(rawStr)) return { normalized: null, answerClass: 'refusal' };

  let s = basicClean(rawStr);
  if (!s) return { normalized: null, answerClass: 'empty' };
  s = s.replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d]);

  if (task.normalize_as === 'integer') {
    let n = null;
    const m = s.match(/-?\d+/);
    if (m) n = parseInt(m[0], 10);
    else if (lang === 'zh') n = zhNumber(s);
    if (n == null) return { normalized: null, answerClass: 'invalid' };
    const range = task.answer_space.match(/(\d+)-(\d+)/);
    const inRange = !range || (n >= +range[1] && n <= +range[2]);
    return { normalized: String(n), answerClass: inRange ? 'valid' : 'invalid' };
  }

  if (task.normalize_as === 'binary') {
    const w = s.toLowerCase().split(' ')[0];
    const c = COIN[lang]?.[w];
    return c ? { normalized: c, answerClass: 'valid' } : { normalized: null, answerClass: 'invalid' };
  }

  const words = s.toLowerCase().split(' ');
  if (task.normalize_as === 'word' && words.length > 3) {
    return { normalized: null, answerClass: 'invalid' }; // whole sentence => off-format
  }
  const w = words[0];
  if (!w) return { normalized: null, answerClass: 'empty' };
  if (task.normalize_as === 'grapheme' && [...w].length > 1 && lang !== 'zh') {
    const single = words.find((x) => [...x].length === 1);
    if (!single) return { normalized: null, answerClass: 'invalid' };
    return { normalized: single, answerClass: 'valid' };
  }
  return { normalized: w, answerClass: 'valid' };
}
