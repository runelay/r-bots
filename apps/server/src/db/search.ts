export function searchTerms(text: string) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 12);
}

export function prefixQuery(terms: string[], weight = "") {
  return terms.map((term) => `${term}:*${weight}`).join(" & ");
}

export const markers = { open: "\u0001", close: "\u0002" };

export function headlineOptions(words: number) {
  return `StartSel=${markers.open}, StopSel=${markers.close}, MaxWords=${words}, MinWords=${Math.min(words, 8)}, ShortWord=0, MaxFragments=1, FragmentDelimiter=" … "`;
}

export function withEllipsis(headline: string, source: string) {
  const plain = headline.replaceAll(markers.open, "").replaceAll(markers.close, "");
  const clean = (value: string) => value.replace(/\s+/g, " ").trim();
  const whole = clean(source);
  const part = clean(plain);
  if (!part || part === whole) return headline;
  const at = whole.indexOf(part);
  const prefix = at > 0 ? "…" : "";
  const suffix = at < 0 || at + part.length < whole.length ? "…" : "";
  return `${prefix}${headline}${suffix}`;
}
