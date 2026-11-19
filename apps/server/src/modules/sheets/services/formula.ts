import type { CellFormat, CellType, CellValue } from "@runelay-bots/protocol";
import FormulaParser from "fast-formula-parser";

const Parser = FormulaParser as unknown as new (config: Record<string, unknown>) => {
  parse: (formula: string, position: { sheet: string; row: number; col: number }, allowReturnArray?: boolean) => unknown;
};
const FormulaError = (FormulaParser as unknown as { FormulaError: new (code: string, message?: string) => object })
  .FormulaError;

export const maxRows = 1_048_576;
export const maxCols = 16_384;

const ptNames: Record<string, string> = {
  SOMA: "SUM",
  MEDIA: "AVERAGE",
  SE: "IF",
  SES: "IFS",
  PROCV: "VLOOKUP",
  PROCH: "HLOOKUP",
  PROCX: "XLOOKUP",
  "CONT.SE": "COUNTIF",
  "CONT.SES": "COUNTIFS",
  "CONT.VALORES": "COUNTA",
  "CONT.NUM": "COUNT",
  "CONTAR.VAZIO": "COUNTBLANK",
  SOMASE: "SUMIF",
  SOMASES: "SUMIFS",
  MEDIASE: "AVERAGEIF",
  MEDIASES: "AVERAGEIFS",
  MAXIMO: "MAX",
  MAX: "MAX",
  MINIMO: "MIN",
  MIN: "MIN",
  ARRED: "ROUND",
  "ARREDONDAR.PARA.CIMA": "ROUNDUP",
  "ARREDONDAR.PARA.BAIXO": "ROUNDDOWN",
  HOJE: "TODAY",
  AGORA: "NOW",
  CONCATENAR: "CONCATENATE",
  E: "AND",
  OU: "OR",
  NAO: "NOT",
  SEERRO: "IFERROR",
  INDICE: "INDEX",
  CORRESP: "MATCH",
  MULT: "PRODUCT",
  SOMARPRODUTO: "SUMPRODUCT",
  TEXTO: "TEXT",
  ESQUERDA: "LEFT",
  DIREITA: "RIGHT",
  "EXT.TEXTO": "MID",
  "NUM.CARACT": "LEN",
  MAIUSCULA: "UPPER",
  MINUSCULA: "LOWER",
  ARRUMAR: "TRIM",
  SUBSTITUIR: "SUBSTITUTE",
  DATA: "DATE",
  ANO: "YEAR",
  MES: "MONTH",
  DIA: "DAY",
  "DIA.DA.SEMANA": "WEEKDAY",
  DIATRABALHOTOTAL: "NETWORKDAYS",
  VALOR: "VALUE",
  RAIZ: "SQRT",
  POTENCIA: "POWER",
  RESTO: "MOD",
  ALEATORIO: "RAND",
  ESCOLHER: "CHOOSE",
  "É.ERRO": "ISERROR",
  "E.ERRO": "ISERROR",
  ÉERROS: "ISERROR",
  ÉCÉL: "ISBLANK",
  "É.CÉL.VAZIA": "ISBLANK",
  "E.CEL.VAZIA": "ISBLANK",
  ÉNÚM: "ISNUMBER",
  ENUM: "ISNUMBER",
  ÉTEXTO: "ISTEXT",
  ETEXTO: "ISTEXT",
  "MÉDIA.GEOMÉTRICA": "GEOMEAN",
  MED: "MEDIAN",
  MAIOR: "LARGE",
  MENOR: "SMALL",
  ORDEM: "RANK",
};

const errorText: Record<string, string> = {
  "#REF!": "A fórmula aponta para uma célula ou aba que não existe.",
  "#DIV/0!": "Divisão por zero.",
  "#NAME?": "Função ou nome desconhecido.",
  "#VALUE!": "Tipo de valor errado na fórmula.",
  "#CYCLE!": "Referência circular: a fórmula depende dela mesma.",
  "#N/A": "Valor não encontrado.",
  "#NUM!": "Número inválido no cálculo.",
  "#NULL!": "Intervalos sem interseção.",
  "#ERROR!": "A fórmula não pôde ser lida.",
};

export function errorMessage(code: string) {
  return errorText[code] ?? "Erro na fórmula.";
}

function strip(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
}

const ptLookup = new Map(Object.entries(ptNames).map(([pt, en]) => [strip(pt), en]));

function splitStrings(formula: string) {
  return formula.split(/("(?:[^"]|"")*")/);
}

export function toEngineFormula(input: string) {
  const body = input.replace(/^=/, "");
  const parts = splitStrings(body);
  const semicolons = parts.some((part, index) => index % 2 === 0 && part.includes(";"));
  const translated = parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      let next = part.replace(/([\p{L}_][\p{L}\p{N}_.]*)(\s*\()/gu, (whole, name: string, paren: string) => {
        const english = ptLookup.get(strip(name));
        return english ? `${english}${paren}` : `${name.toUpperCase()}${paren}`;
      });
      next = next.replace(/(?<![\p{L}\p{N}_.])(VERDADEIRO|FALSO)(?![\p{L}\p{N}_(])/giu, (word: string) =>
        strip(word) === "FALSO" ? "FALSE" : "TRUE",
      );
      if (semicolons) next = next.replace(/(\d),(\d)/g, "$1.$2").replace(/;/g, ",");
      return next;
    })
    .join("");
  return semicolons ? translated : topLevelDecimals(translated);
}

function topLevelDecimals(formula: string) {
  let depth = 0;
  let quoted = false;
  let out = "";
  for (let index = 0; index < formula.length; index++) {
    const char = formula[index];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "(") depth++;
    else if (!quoted && char === ")") depth--;
    if (
      !quoted &&
      char === "," &&
      depth === 0 &&
      /\d/.test(formula[index - 1] ?? "") &&
      /\d/.test(formula[index + 1] ?? "")
    )
      out += ".";
    else out += char;
  }
  return out;
}

export function colIndex(letters: string) {
  let value = 0;
  for (const char of letters.toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64);
  return value - 1;
}

export function colLetters(index: number) {
  let name = "";
  let rest = index + 1;
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    rest = Math.floor((rest - 1) / 26);
  }
  return name;
}

export function address(row: number, col: number) {
  return `${colLetters(col)}${row + 1}`;
}

export interface CellPoint {
  r: number;
  c: number;
}

export function parseAddress(value: string): CellPoint {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(value.trim());
  if (!match) throw new Error(`Endereço inválido: ${value}`);
  const r = Number(match[2]) - 1;
  const c = colIndex(match[1]);
  if (r < 0 || r >= maxRows || c >= maxCols) throw new Error(`Endereço fora da planilha: ${value}`);
  return { r, c };
}

export interface CellRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export function parseRange(value: string): CellRange {
  const text = value.trim().replace(/\$/g, "");
  const [left, right = left] = text.split(":");
  const col = /^[A-Za-z]{1,3}$/;
  const row = /^\d{1,7}$/;
  if (col.test(left) && col.test(right)) {
    const [a, b] = [colIndex(left), colIndex(right)].sort((x, y) => x - y);
    return { r1: 0, c1: a, r2: maxRows - 1, c2: b };
  }
  if (row.test(left) && row.test(right)) {
    const [a, b] = [Number(left) - 1, Number(right) - 1].sort((x, y) => x - y);
    if (a < 0) throw new Error(`Intervalo inválido: ${value}`);
    return { r1: a, c1: 0, r2: b, c2: maxCols - 1 };
  }
  const start = parseAddress(left);
  const end = parseAddress(right);
  return {
    r1: Math.min(start.r, end.r),
    c1: Math.min(start.c, end.c),
    r2: Math.max(start.r, end.r),
    c2: Math.max(start.c, end.c),
  };
}

export function rangeText(range: CellRange) {
  const start = address(range.r1, range.c1);
  const end = address(range.r2, range.c2);
  return start === end ? start : `${start}:${end}`;
}

export interface ParsedInput {
  formula: string | null;
  v: CellValue;
  t: CellType;
  hint?: CellFormat;
}

function excelSerial(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

function parseNumber(raw: string): number | null {
  let text = raw.replace(/\s/g, "");
  if (!/^[-+]?[\d.,]+$/.test(text)) return null;
  const hasComma = text.includes(",");
  const hasDot = text.includes(".");
  if (hasComma && hasDot) {
    text = text.lastIndexOf(",") > text.lastIndexOf(".") ? text.replace(/\./g, "").replace(",", ".") : text.replace(/,/g, "");
  } else if (hasComma) {
    if ((text.match(/,/g) ?? []).length > 1) return null;
    text = text.replace(",", ".");
  } else if (hasDot && /^[-+]?\d{1,3}(\.\d{3})+$/.test(text)) {
    text = text.replace(/\./g, "");
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export function parseInput(input: string): ParsedInput {
  const text = input.trim();
  if (text.startsWith("=") && text.length > 1) return { formula: text, v: null, t: null };
  if (input.startsWith("'")) return { formula: null, v: input.slice(1), t: "s" };
  if (!text) return { formula: null, v: null, t: null };
  const upper = strip(text);
  if (upper === "TRUE" || upper === "VERDADEIRO") return { formula: null, v: true, t: "b" };
  if (upper === "FALSE" || upper === "FALSO") return { formula: null, v: false, t: "b" };
  const money = /^(-?)\s*R\$\s*(.+)$/i.exec(text);
  if (money) {
    const value = parseNumber(money[2]);
    if (value !== null) return { formula: null, v: money[1] ? -value : value, t: "n", hint: { type: "brl", decimals: 2 } };
  }
  const percent = /^(.+)%$/.exec(text);
  if (percent) {
    const value = parseNumber(percent[1]);
    if (value !== null) return { formula: null, v: value / 100, t: "n", hint: { type: "percent" } };
  }
  const date = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text) ?? null;
  if (date) {
    const [d, m, y] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const parsed = new Date(Date.UTC(y, m - 1, d));
    if (parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d)
      return { formula: null, v: parsed.toISOString().slice(0, 10), t: "d", hint: { type: "date" } };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text)))
    return { formula: null, v: text, t: "d", hint: { type: "date" } };
  const value = parseNumber(text);
  if (value !== null) return { formula: null, v: value, t: "n" };
  return { formula: null, v: input, t: "s" };
}

export interface BookCell {
  r: number;
  c: number;
  input: string;
  v: CellValue;
  t: CellType;
  error?: string | null;
}

export interface BookTab {
  id: string;
  name: string;
  rowCount: number;
  colCount: number;
  cells: Map<string, BookCell>;
}

export interface Computed {
  v: CellValue;
  t: CellType;
  error: string | null;
}

const key = (r: number, c: number) => `${r},${c}`;

function isFormulaError(value: unknown): value is { _error?: string; error?: string } {
  return Boolean(value) && value instanceof (FormulaError as unknown as new () => object);
}

function errorCode(value: unknown) {
  const raw = (value as { _error?: string; error?: string })._error ?? (value as { error?: string }).error;
  return typeof raw === "string" && raw.startsWith("#") ? raw : "#ERROR!";
}

function flatValues(arg: unknown): unknown[] {
  const value = (arg as { value?: unknown })?.value ?? arg;
  if (Array.isArray(value)) return value.flat(2);
  return [value];
}

function xlookup(lookup: unknown, lookupArray: unknown, returnArray: unknown, notFound?: unknown) {
  const needle = (lookup as { value?: unknown })?.value ?? lookup;
  const keys = flatValues(lookupArray);
  const values = flatValues(returnArray);
  const wanted = typeof needle === "string" ? needle.toLowerCase() : needle;
  const index = keys.findIndex((item) => (typeof item === "string" ? item.toLowerCase() : item) === wanted);
  if (index < 0) {
    const fallback = (notFound as { value?: unknown } | undefined)?.value;
    return fallback === undefined ? new FormulaError("#N/A") : fallback;
  }
  return values[index] ?? null;
}

function numbersOf(args: unknown[]) {
  const out: number[] = [];
  for (const arg of args) {
    const direct = !(arg as { isRangeRef?: boolean; isArray?: boolean })?.isRangeRef && !(arg as { isArray?: boolean })?.isArray;
    for (const item of flatValues(arg)) {
      if (isFormulaError(item)) throw item;
      if (typeof item === "number") out.push(item);
      else if (direct && typeof item === "boolean") out.push(item ? 1 : 0);
      else if (direct && typeof item === "string" && item.trim() && Number.isFinite(Number(item))) out.push(Number(item));
    }
  }
  return out;
}

function criteriaOf(raw: unknown) {
  const value = (raw as { value?: unknown })?.value ?? raw;
  if (typeof value === "number" || typeof value === "boolean") return (item: unknown) => item === value;
  const text = String(value ?? "");
  const match = /^(<=|>=|<>|=|<|>)?(.*)$/s.exec(text)!;
  const op = match[1] ?? "=";
  const operand = match[2];
  const numeric = operand.trim() !== "" && Number.isFinite(Number(operand)) ? Number(operand) : null;
  const pattern = new RegExp(
    `^${operand
      .toLowerCase()
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
    "s",
  );
  return (item: unknown) => {
    if (numeric !== null && typeof item === "number") {
      if (op === "=") return item === numeric;
      if (op === "<>") return item !== numeric;
      if (op === "<") return item < numeric;
      if (op === ">") return item > numeric;
      if (op === "<=") return item <= numeric;
      return item >= numeric;
    }
    if (op === "<" || op === ">" || op === "<=" || op === ">=") return false;
    const hit = operand === "" ? item === null || item === "" : pattern.test(String(item ?? "").toLowerCase());
    return op === "<>" ? !hit : hit;
  };
}

function ifsIndexes(pairs: unknown[]) {
  let hits: boolean[] | null = null;
  for (let index = 0; index + 1 < pairs.length; index += 2) {
    const values = flatValues(pairs[index]);
    const test = criteriaOf(pairs[index + 1]);
    const current = values.map((item) => test(item));
    hits = hits ? hits.map((hit, i) => hit && Boolean(current[i])) : current;
  }
  return hits ?? [];
}

function kth(args: unknown[], pick: (sorted: number[], k: number) => number | undefined) {
  const values = numbersOf([args[0]]).sort((a, b) => a - b);
  const k = Number((args[1] as { value?: unknown })?.value);
  const result = pick(values, k);
  return result === undefined ? new FormulaError("#NUM!") : result;
}

const extraFunctions: Record<string, (...args: unknown[]) => unknown> = {
  XLOOKUP: xlookup,
  MAX: (...args) => {
    const values = numbersOf(args);
    return values.length ? Math.max(...values) : 0;
  },
  MIN: (...args) => {
    const values = numbersOf(args);
    return values.length ? Math.min(...values) : 0;
  },
  MEDIAN: (...args) => {
    const values = numbersOf(args).sort((a, b) => a - b);
    if (!values.length) return new FormulaError("#NUM!");
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  },
  LARGE: (...args) => kth(args, (sorted, k) => sorted[sorted.length - k]),
  SMALL: (...args) => kth(args, (sorted, k) => sorted[k - 1]),
  COUNTA: (...args) => args.flatMap(flatValues).filter((item) => item !== null && item !== "").length,
  COUNTBLANK: (...args) => args.flatMap(flatValues).filter((item) => item === null || item === "").length,
  COUNTIFS: (...args) => ifsIndexes(args).filter(Boolean).length,
  SUMIFS: (sum, ...pairs) => {
    const values = flatValues(sum);
    return ifsIndexes(pairs).reduce((total, hit, i) => total + (hit && typeof values[i] === "number" ? (values[i] as number) : 0), 0);
  },
  AVERAGEIFS: (avg, ...pairs) => {
    const values = flatValues(avg);
    const picked = ifsIndexes(pairs)
      .map((hit, i) => (hit && typeof values[i] === "number" ? (values[i] as number) : null))
      .filter((item): item is number => item !== null);
    return picked.length ? picked.reduce((a, b) => a + b, 0) / picked.length : new FormulaError("#DIV/0!");
  },
  MATCH: (lookup, array, type) => {
    const needle = (lookup as { value?: unknown })?.value ?? lookup;
    const mode = Number((type as { value?: unknown } | undefined)?.value ?? 1);
    const values = flatValues(array);
    if (mode === 0) {
      const test = criteriaOf(typeof needle === "string" ? needle : { value: needle });
      const index = values.findIndex((item) => test(item));
      return index < 0 ? new FormulaError("#N/A") : index + 1;
    }
    let found = -1;
    for (let i = 0; i < values.length; i++) {
      const item = values[i] as number | string;
      if (item === null) continue;
      if (mode > 0 ? item <= (needle as number) : item >= (needle as number)) found = i;
      else break;
    }
    return found < 0 ? new FormulaError("#N/A") : found + 1;
  },
  UPPER: (text) => String((text as { value?: unknown })?.value ?? "").toLocaleUpperCase("pt-BR"),
  VALUE: (text) => {
    const raw = (text as { value?: unknown })?.value;
    if (typeof raw === "number") return raw;
    const parsed = parseInput(String(raw ?? ""));
    return parsed.t === "n" ? parsed.v : new FormulaError("#VALUE!");
  },
};

export class Workbook {
  private readonly byName = new Map<string, BookTab>();
  private readonly results = new Map<string, Computed>();
  private readonly visiting = new Set<string>();
  private readonly parser: InstanceType<typeof Parser>;

  constructor(readonly tabs: BookTab[]) {
    for (const tab of tabs) this.byName.set(tab.name.toLocaleLowerCase("pt-BR"), tab);
    this.parser = new Parser({
      onCell: ({ sheet, row, col }: { sheet: string; row: number; col: number }) =>
        this.valueAt(sheet, row - 1, col - 1),
      onRange: (ref: { sheet: string; from: { row: number; col: number }; to: { row: number; col: number } }) =>
        this.rangeAt(ref.sheet, ref.from.row - 1, ref.from.col - 1, ref.to.row - 1, ref.to.col - 1),
      functions: extraFunctions,
    });
  }

  private tabNamed(name: string) {
    const tab = this.byName.get(name.toLocaleLowerCase("pt-BR"));
    if (!tab) throw new FormulaError("#REF!");
    return tab;
  }

  private valueAt(sheet: string, r: number, c: number): unknown {
    const tab = this.tabNamed(sheet);
    const cell = tab.cells.get(key(r, c));
    if (!cell) return null;
    const result = this.compute(tab, cell);
    if (result.t === "e") return new FormulaError(String(result.v));
    if (result.t === "d" && typeof result.v === "string") return excelSerial(result.v);
    return result.v;
  }

  private rangeAt(sheet: string, r1: number, c1: number, r2: number, c2: number) {
    const tab = this.tabNamed(sheet);
    const lastRow = Math.min(r2, Math.max(tab.rowCount - 1, r1));
    const lastCol = Math.min(c2, Math.max(tab.colCount - 1, c1));
    const rows: unknown[][] = [];
    for (let r = r1; r <= lastRow; r++) {
      const row: unknown[] = [];
      for (let c = c1; c <= lastCol; c++) row.push(this.valueAt(sheet, r, c));
      rows.push(row);
    }
    return rows;
  }

  compute(tab: BookTab, cell: BookCell): Computed {
    const id = `${tab.id}:${cell.r},${cell.c}`;
    const known = this.results.get(id);
    if (known) return known;
    const parsed = parseInput(cell.input);
    if (!parsed.formula) {
      const plain = { v: parsed.v, t: parsed.t, error: null };
      this.results.set(id, plain);
      return plain;
    }
    if (this.visiting.has(id)) return { v: "#CYCLE!", t: "e", error: errorMessage("#CYCLE!") };
    this.visiting.add(id);
    let result: Computed;
    try {
      let value = this.parser.parse(toEngineFormula(parsed.formula), { sheet: tab.name, row: cell.r + 1, col: cell.c + 1 });
      if (Array.isArray(value)) value = value.flat(2)[0] ?? null;
      result = this.toComputed(value);
    } catch (error) {
      result = this.toComputed(this.errorFrom(error));
    } finally {
      this.visiting.delete(id);
    }
    if (result.t === "e" && result.v === "#CYCLE!" && this.visiting.size) return result;
    this.results.set(id, result);
    return result;
  }

  private errorFrom(error: unknown) {
    const message = `${(error as Error)?.message ?? ""} ${String((error as { details?: unknown })?.details ?? "")}`;
    if (/not implemented/i.test(message)) return new FormulaError("#NAME?");
    const inner = (error as { details?: unknown })?.details;
    if (isFormulaError(inner) && errorCode(inner) !== "#ERROR!") return inner;
    if (isFormulaError(error)) return error;
    return new FormulaError("#ERROR!");
  }

  private toComputed(value: unknown): Computed {
    if (isFormulaError(value)) {
      const code = errorCode(value);
      return { v: code, t: "e", error: errorMessage(code) };
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return { v: "#NUM!", t: "e", error: errorMessage("#NUM!") };
      return { v: Math.round(value * 1e12) / 1e12, t: "n", error: null };
    }
    if (typeof value === "boolean") return { v: value, t: "b", error: null };
    if (value === null || value === undefined) return { v: 0, t: "n", error: null };
    return { v: String(value), t: "s", error: null };
  }

  computeAll() {
    const out = new Map<string, Map<string, Computed>>();
    for (const tab of this.tabs) {
      const map = new Map<string, Computed>();
      for (const cell of tab.cells.values()) map.set(key(cell.r, cell.c), this.compute(tab, cell));
      out.set(tab.id, map);
    }
    return out;
  }
}

export function quoteSheet(name: string) {
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

const refPattern =
  /(?<![\p{L}\p{N}_.$])((?:'(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}_.]*)!)?(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d+:\$?\d+)(?![\p{L}\p{N}_(!])/gu;

export type StructureOp = "insert_rows" | "delete_rows" | "insert_cols" | "delete_cols";

function sheetOf(prefix: string | undefined) {
  if (!prefix) return null;
  const raw = prefix.slice(0, -1);
  return raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw;
}

function shiftIndex(index: number, op: StructureOp, at: number, count: number): number | null {
  if (op.startsWith("insert")) return index >= at ? index + count : index;
  if (index >= at && index < at + count) return null;
  return index >= at + count ? index - count : index;
}

function shiftBounds(start: number, end: number, op: StructureOp, at: number, count: number) {
  if (op.startsWith("insert")) return [shiftIndex(start, op, at, count)!, shiftIndex(end, op, at, count)!];
  const nextStart = start >= at && start < at + count ? at : start >= at + count ? start - count : start;
  const nextEnd = end >= at && end < at + count ? at - 1 : end >= at + count ? end - count : end;
  return nextEnd < nextStart ? null : [nextStart, nextEnd];
}

export function shiftFormula(
  input: string,
  ownTab: string,
  targetTab: string,
  op: StructureOp,
  at: number,
  count: number,
) {
  if (!input.trim().startsWith("=")) return input;
  const rows = op.endsWith("rows");
  const target = targetTab.toLocaleLowerCase("pt-BR");
  return splitStrings(input)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(refPattern, (whole, prefix: string | undefined, ref: string) => {
            const sheet = sheetOf(prefix) ?? ownTab;
            if (sheet.toLocaleLowerCase("pt-BR") !== target) return whole;
            const pieces = ref.split(":");
            const parsed = pieces.map((piece) => /^(\$?)([A-Za-z]*)(\$?)(\d*)$/.exec(piece)!);
            const isCol = parsed.every((m) => m[2] && !m[4]);
            const isRow = parsed.every((m) => !m[2] && m[4]);
            if ((rows && isCol) || (!rows && isRow)) return whole;
            const values = parsed.map((m) => (rows ? Number(m[4]) - 1 : colIndex(m[2])));
            const bounds =
              values.length === 1
                ? (() => {
                    const moved = shiftIndex(values[0], op, at, count);
                    return moved === null ? null : [moved];
                  })()
                : shiftBounds(values[0], values[1], op, at, count);
            if (!bounds) return "#REF!";
            const rebuilt = parsed.map((m, i) =>
              rows ? `${m[1]}${m[2]}${m[3]}${bounds[i] + 1}` : `${m[1]}${colLetters(bounds[i])}${m[3]}${m[4]}`,
            );
            return `${prefix ?? ""}${rebuilt.join(":")}`;
          }),
    )
    .join("");
}

export function renameSheetRefs(input: string, from: string, to: string) {
  if (!input.trim().startsWith("=")) return input;
  const wanted = from.toLocaleLowerCase("pt-BR");
  return splitStrings(input)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(refPattern, (whole, prefix: string | undefined, ref: string) => {
            const sheet = sheetOf(prefix);
            if (!sheet || sheet.toLocaleLowerCase("pt-BR") !== wanted) return whole;
            return `${quoteSheet(to)}!${ref}`;
          }),
    )
    .join("");
}

export function excelFormula(input: string) {
  return toEngineFormula(input.trim());
}

export { excelSerial };
