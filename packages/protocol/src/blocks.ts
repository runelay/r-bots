export const blockKinds = ["note", "sheet", "agenda"] as const;
export type BlockKind = (typeof blockKinds)[number];

export type BlockAuthor = "bot" | "user";
export type BlockAction = "created" | "edited" | "deleted";

export const agendaBlockId = "agenda";

export interface Page<Item> {
  items: Item[];
  nextCursor: string | null;
  total: number;
}

export interface NotePreview {
  kind: "note";
  folder: string;
  excerpt: string;
  words: number;
}

export interface SheetPreviewCell {
  v: CellValue;
  t: CellType;
  format?: CellFormat;
}

export interface SheetPreview {
  kind: "sheet";
  tab: string;
  tabs: number;
  rows: SheetPreviewCell[][];
  rowCount: number;
  colCount: number;
  frozenRows: number;
  colWidths: number[];
}

export interface AgendaPreview {
  kind: "agenda";
  view: "day" | "week";
  start: string;
  end: string;
  timezone: string;
  accounts: AgendaAccountRef[];
  events: AgendaEventPreview[];
}

export type BlockPreview = NotePreview | SheetPreview | AgendaPreview;

export interface NoteChange {
  lines: Array<[number, number]>;
}

export interface SheetChange {
  tabId: string;
  ranges: string[];
}

export interface AgendaChange {
  eventIds: string[];
}

export type BlockChange = NoteChange | SheetChange | AgendaChange;

export interface BlockEventData {
  botId: string;
  kind: BlockKind;
  id: string;
  title: string;
  version: number;
  author: BlockAuthor;
  action: BlockAction;
  callId?: string;
  preview: BlockPreview | null;
  changed?: BlockChange;
}

export type BlockStreamEvent =
  | { type: "block.created"; data: BlockEventData }
  | { type: "block.updated"; data: BlockEventData }
  | { type: "block.deleted"; data: Omit<BlockEventData, "preview" | "changed"> & { preview: null } };

export interface NoteSummary {
  id: string;
  title: string;
  folder: string;
  version: number;
  updatedAt: string;
  updatedBy: BlockAuthor;
  excerpt: string;
  tags: string[];
}

export interface NoteLink {
  target: string;
  id: string | null;
  title: string;
}

export interface Note extends NoteSummary {
  content: string;
  links: NoteLink[];
  backlinkCount: number;
}

export interface NoteBacklink {
  id: string;
  title: string;
  folder: string;
  snippet: string;
}

export interface NoteFolder {
  name: string;
  path: string;
  notes: number;
  folders: number;
}

export interface NoteTreeLevel {
  folder: string;
  folders: NoteFolder[];
  notes: Page<NoteSummary>;
}

export interface NoteSearchHit {
  id: string;
  title: string;
  folder: string;
  snippet: string;
  ranges: Array<[number, number]>;
}

export type NoteListSort = "updated" | "title";

export interface NoteListQuery {
  folder?: string;
  q?: string;
  tag?: string;
  sort?: NoteListSort;
  cursor?: string;
  limit?: number;
}

export interface NoteCreateBody {
  title: string;
  folder?: string;
  content?: string;
}

export interface NoteWriteBody {
  content: string;
  title?: string;
  baseVersion?: number;
}

export type NotePatchOp =
  | { op: "replace"; old: string; new: string }
  | { op: "append"; text: string }
  | { op: "prepend"; text: string }
  | { op: "insert_after_heading"; heading: string; text: string }
  | { op: "toggle_task"; line: number; done: boolean };

export interface NotePatchBody {
  ops: NotePatchOp[];
  baseVersion?: number;
}

export interface NoteMoveBody {
  folder?: string;
  title?: string;
}

export interface NoteMoveResult {
  note: Note;
  relinked: number;
}

export type CellValue = number | string | boolean | null;
export type CellType = "n" | "s" | "b" | "d" | "e" | null;
export type CellFormatType = "general" | "number" | "brl" | "percent" | "date" | "datetime" | "text";

export interface CellFormat {
  type: CellFormatType;
  decimals?: number;
  bold?: boolean;
  align?: "left" | "center" | "right";
}

export interface SheetCell {
  a: string;
  r: number;
  c: number;
  input: string;
  v: CellValue;
  t: CellType;
  format?: CellFormat;
  error?: string;
}

export interface SheetTab {
  id: string;
  name: string;
  index: number;
  rowCount: number;
  colCount: number;
  frozenRows: number;
  frozenCols: number;
  colWidths: Record<string, number>;
}

export interface SheetSummary {
  id: string;
  title: string;
  version: number;
  updatedAt: string;
  updatedBy: BlockAuthor;
  tabs: Array<Pick<SheetTab, "id" | "name">>;
}

export interface Sheet extends Omit<SheetSummary, "tabs"> {
  tabs: SheetTab[];
}

export interface SheetRange {
  tabId: string;
  range: string;
  version: number;
  cells: SheetCell[];
}

export interface SheetWriteBody {
  baseVersion?: number;
  cells: Array<{ a: string; input: string }>;
}

export interface SheetWriteResult {
  version: number;
  cells: SheetCell[];
}

export interface SheetFormatBody {
  ranges: string[];
  format: Partial<CellFormat> | null;
}

export interface SheetTabPatchBody {
  name?: string;
  frozenRows?: number;
  frozenCols?: number;
  colWidths?: Record<string, number>;
}

export type SheetStructureOp = "insert_rows" | "delete_rows" | "insert_cols" | "delete_cols";

export interface SheetStructureBody {
  op: SheetStructureOp;
  at: number;
  count: number;
}

export interface AgendaAccountRef {
  id: string;
  label: string;
  color: string;
}

export interface AgendaAccount extends AgendaAccountRef {
  email: string;
  primary: boolean;
  status: "ready" | "needs_auth";
  calendars: Array<{ id: string; name: string; color: string; selected: boolean }>;
}

export type AttendeeResponse = "accepted" | "declined" | "tentative" | "needsAction";

export interface AgendaEventPreview {
  id: string;
  accountId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  meet: boolean;
}

export interface AgendaEvent extends AgendaEventPreview {
  calendarId: string;
  location: string | null;
  description: string | null;
  meetUrl: string | null;
  calendarUrl: string | null;
  attendees: Array<{
    email: string;
    name: string | null;
    response: AttendeeResponse;
    self: boolean;
    organizer: boolean;
  }>;
  status: "confirmed" | "tentative" | "cancelled";
  recurring: boolean;
  updatedAt: string;
}

export interface AgendaListQuery {
  start: string;
  end: string;
  accounts?: string;
  q?: string;
}

export interface AgendaList {
  timezone: string;
  items: AgendaEvent[];
}

export interface AgendaEventBody {
  accountId: string;
  calendarId?: string;
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  location?: string | null;
  description?: string | null;
  attendees?: string[];
  meet?: boolean;
}

export const noteExportFormats = ["docx", "pdf", "md"] as const;
export const sheetExportFormats = ["xlsx", "csv", "pdf"] as const;
export type NoteExportFormat = (typeof noteExportFormats)[number];
export type SheetExportFormat = (typeof sheetExportFormats)[number];
export type ExportFormat = NoteExportFormat | SheetExportFormat;

export interface ExportBody {
  kind: "note" | "sheet";
  id: string;
  format: ExportFormat;
  tabId?: string;
}

export interface ExportJob {
  id: string;
  kind: "note" | "sheet";
  sourceId: string;
  format: ExportFormat;
  status: "pending" | "ready" | "failed";
  fileName: string;
  size: number | null;
  url: string | null;
  error: string | null;
  createdAt: string;
}

export function exportFormatsFor(kind: "note" | "sheet"): readonly ExportFormat[] {
  return kind === "note" ? noteExportFormats : sheetExportFormats;
}

export function columnName(index: number): string {
  let name = "";
  let rest = index + 1;
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    rest = Math.floor((rest - 1) / 26);
  }
  return name;
}

export function cellAddress(row: number, col: number): string {
  return `${columnName(col)}${row + 1}`;
}
