/**
 * Local (in-process) sensitive-data detection. Runs entirely on our server —
 * no text is sent anywhere to be scanned. Pattern + checksum based, so it
 * covers structured values (emails, cards, IDs, keys, …) but not free-form
 * ones like street addresses or names.
 */

export type SensitiveSpan = { start: number; end: number; value: string; type: string };

type Detector = {
  type: string;
  /** Must have the `g` flag. With `valueGroup`, also needs `d` (match indices). */
  pattern: RegExp;
  /** Named group holding the value to mask (e.g. the part after "password:"); whole match otherwise. */
  valueGroup?: string;
  validate?: (value: string, match: RegExpMatchArray) => boolean;
};

function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Aadhaar numbers carry a Verhoeff check digit. */
function verhoeffValid(digits: string): boolean {
  let c = 0;
  const reversed = digits.split("").reverse();
  for (let i = 0; i < reversed.length; i++) {
    const row = VERHOEFF_D[c];
    const perm = VERHOEFF_P[i % 8];
    if (!row || !perm) return false;
    c = row[perm[Number(reversed[i])] ?? 0] ?? 0;
  }
  return c === 0;
}

function ibanValid(value: string): boolean {
  const iban = value.replace(/\s/g, "").toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of code) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const DATE =
  String.raw`\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}` +
  String.raw`|\d{4}-\d{1,2}-\d{1,2}` +
  String.raw`|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9},?\s+\d{4}` +
  String.raw`|[A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}`;

const DETECTORS: Detector[] = [
  // --- Secrets with a recognisable shape ---
  {
    type: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { type: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { type: "api_key", pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { type: "api_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "api_key", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { type: "api_key", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { type: "api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: "api_key", pattern: /\brzp_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
  {
    type: "token",
    pattern: /\bBearer\s+(?<v>[A-Za-z0-9._~+\/-]{16,}=*)/dg,
    valueGroup: "v",
  },
  {
    // "password: hunter2", "api_key=abc123", "my pin is 4821"
    type: "secret",
    pattern:
      /\b(?:password|passwd|pwd|passcode|pin|otp|secret|token|api[_\s-]?key|access[_\s-]?key|private[_\s-]?key)\b\s*(?<sep>:|=|\bis\b)?\s*["']?(?<v>[^\s"',;]{4,})/dgi,
    valueGroup: "v",
    // Without an explicit ":"/"=", only mask values that look like secrets,
    // so prose like "the password is incorrect" is left alone.
    validate: (value, match) => {
      const sep = match.groups?.sep;
      if (sep === ":" || sep === "=") return true;
      return /[\d\W_]/.test(value);
    },
  },

  // --- Contact details ---
  { type: "email", pattern: /(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g },
  {
    type: "phone",
    pattern: /(?<![\w+])\+\d{1,3}[\s.-]?(?:\(?\d{1,4}\)?[\s.-]?){1,5}\d{2,4}(?!\w)/g,
    validate: (value) => {
      const n = digitsOf(value).length;
      return n >= 8 && n <= 15;
    },
  },
  { type: "phone", pattern: /(?<![\w+])0?[6-9]\d{4}[\s-]?\d{5}(?![\w])/g }, // Indian mobile
  { type: "phone", pattern: /(?<![\w+])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\w)/g }, // US-style

  // --- Financial ---
  {
    type: "card",
    pattern: /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g,
    validate: (value) => {
      const d = digitsOf(value);
      return d.length >= 13 && d.length <= 19 && luhnValid(d);
    },
  },
  {
    type: "iban",
    pattern: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g,
    validate: ibanValid,
  },
  { type: "ifsc", pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
  {
    type: "bank_account",
    pattern:
      /\b(?:account|acct|a\/c)(?:\s*(?:number|num|no\.?|#))?\s*(?:is|:|#|-)?\s*(?<v>\d[\d\s-]{6,22}\d)/dgi,
    valueGroup: "v",
    validate: (value) => {
      const n = digitsOf(value).length;
      return n >= 9 && n <= 18;
    },
  },
  {
    type: "routing_number",
    pattern: /\b(?:routing|aba)(?:\s*(?:number|num|no\.?|#))?\s*(?:is|:|#|-)?\s*(?<v>\d{9})\b/dgi,
    valueGroup: "v",
  },

  // --- Government IDs ---
  {
    type: "aadhaar",
    pattern: /(?<![\d-])[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?![\d-])/g,
    validate: (value) => verhoeffValid(digitsOf(value)),
  },
  { type: "pan", pattern: /\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b/g },
  { type: "ssn", pattern: /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g },

  // --- Labelled values: the user said what it is, so skip format/checksum checks ---
  // ("my aadhar 1234 5674 1234" must be masked even though it isn't a valid Aadhaar.)
  {
    type: "aadhaar",
    pattern:
      /\b(?:aadhaa?r|adhaa?r|uid(?:ai)?)\b(?:\s*(?:card|number|num|no\.?|#))?\s*(?:is|:|#|-)?\s*(?<v>\d{4}[\s-]?\d{4}[\s-]?\d{4})(?!\d)/dgi,
    valueGroup: "v",
  },
  {
    type: "card",
    pattern:
      /\b(?:(?:credit|debit)\s+)?card(?:\s*(?:number|num|no\.?|#))?\s*(?:is|:|#|-)?\s*(?<v>(?:\d[ -]?){11,18}\d)(?!\d)/dgi,
    valueGroup: "v",
  },
  {
    type: "pan",
    pattern: /\bpan(?:\s*(?:card|number|num|no\.?|#))?\s*(?:is|:|#|-)?\s*(?<v>[A-Za-z]{5}\d{4}[A-Za-z])\b/dgi,
    valueGroup: "v",
  },
  {
    type: "ssn",
    pattern:
      /\b(?:ssn|social\s+security(?:\s+number)?)(?:\s*(?:number|num|no\.?|#))?\s*(?:is|:|#|-)?\s*(?<v>\d{3}[\s-]?\d{2}[\s-]?\d{4})(?!\d)/dgi,
    valueGroup: "v",
  },
  {
    type: "phone",
    pattern:
      /\b(?:phone|mobile|cell|contact|whatsapp|tel)(?:\s*(?:number|num|no\.?|#))?\s*(?:is|:|#|-)?\s*(?<v>\+?\d[\d\s().-]{5,18}\d)(?!\d)/dgi,
    valueGroup: "v",
    validate: (value) => {
      const n = digitsOf(value).length;
      return n >= 7 && n <= 15;
    },
  },

  // --- Date of birth (only next to a DOB keyword; plain dates are left alone) ---
  {
    type: "date_of_birth",
    pattern: new RegExp(
      String.raw`\b(?:dob|d\.o\.b\.?|date\s+of\s+birth|born(?:\s+on)?|birth\s?day)\b\s*(?:is|:|-)?\s*(?<v>${DATE})`,
      "dgi"
    ),
    valueGroup: "v",
  },
];

/** All sensitive spans in `text`, non-overlapping, in order. */
export function findSensitiveSpans(text: string): SensitiveSpan[] {
  const candidates: SensitiveSpan[] = [];

  for (const detector of DETECTORS) {
    for (const match of text.matchAll(detector.pattern)) {
      let start = match.index ?? 0;
      let value = match[0];
      if (detector.valueGroup) {
        const groupValue = match.groups?.[detector.valueGroup];
        const range = match.indices?.groups?.[detector.valueGroup];
        if (!groupValue || !range) continue;
        value = groupValue;
        start = range[0];
      }
      if (!value.trim()) continue;
      if (detector.validate && !detector.validate(value, match)) continue;
      candidates.push({ start, end: start + value.length, value, type: detector.type });
    }
  }

  // Earliest first, longest first on ties; drop anything overlapping a kept span.
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const spans: SensitiveSpan[] = [];
  let lastEnd = -1;
  for (const span of candidates) {
    if (span.start < lastEnd) continue;
    spans.push(span);
    lastEnd = span.end;
  }
  return spans;
}
