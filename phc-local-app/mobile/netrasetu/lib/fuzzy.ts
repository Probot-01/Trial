

export function normalizeName(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-zऀ-෿ ]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizePhone(s: string): string {
  const digits = s.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** 0..1, 1 = identical after normalisation. */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  const longest = Math.max(x.length, y.length);
  return 1 - levenshtein(x, y) / longest;
}

export interface MatchInput { name: string; age: number | null; phone: string }
export interface MatchCandidate { name: string; age: number; contactNumber: string }

export function scoreMatch(input: MatchInput, c: MatchCandidate): { score: number; matchedOn: string[] } {
  const matchedOn: string[] = [];
  let score = 0;
  const p1 = normalizePhone(input.phone);
  const p2 = normalizePhone(c.contactNumber);
  if (p1.length >= 10 && p1 === p2) { score += 0.6; matchedOn.push('phone'); }
  const sim = nameSimilarity(input.name, c.name);
  if (sim >= 0.8) { score += 0.3 * sim; matchedOn.push('name'); }
  if (input.age !== null && Math.abs(input.age - c.age) <= 2) {
    score += 0.1;
    if (matchedOn.length) matchedOn.push('age');
  }
  return { score: matchedOn.length ? score : 0, matchedOn };
}
