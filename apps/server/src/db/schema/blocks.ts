import { bigint, index, integer, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import { jsonb, timestamptz } from "./types";

export const notes = pgTable(
  "notes",
  {
    id: text("id").primaryKey(),
    folder: text("folder").notNull().default(""),
    title: text("title").notNull(),
    markdown: text("markdown").notNull().default(""),
    botId: text("bot_id"),
    version: integer("version").notNull().default(1),
    updatedBy: text("updated_by").notNull().default("bot"),
    seenVersion: integer("seen_version").notNull().default(0),
    notifiedVersion: integer("notified_version").notNull().default(0),
    userChanges: jsonb<unknown[]>("user_changes"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    deletedAt: timestamptz("deleted_at"),
  },
  (table) => [index("notes_folder_idx").on(table.folder, table.deletedAt), index("notes_title_idx").on(table.title)],
);

export const noteLinks = pgTable(
  "note_links",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    targetTitle: text("target_title").notNull(),
    targetId: text("target_id").references(() => notes.id, { onDelete: "set null" }),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.targetTitle] }),
    index("note_links_target_idx").on(table.targetId),
    index("note_links_target_title_idx").on(table.targetTitle),
  ],
);

export const sheets = pgTable(
  "sheets",
  {
    id: text("id").primaryKey(),
    folder: text("folder").notNull().default(""),
    title: text("title").notNull(),
    botId: text("bot_id"),
    version: integer("version").notNull().default(1),
    updatedBy: text("updated_by").notNull().default("bot"),
    seenVersion: integer("seen_version").notNull().default(0),
    notifiedVersion: integer("notified_version").notNull().default(0),
    userChanges: jsonb<unknown[]>("user_changes"),
    createdAt: timestamptz("created_at").notNull(),
    updatedAt: timestamptz("updated_at").notNull(),
    deletedAt: timestamptz("deleted_at"),
  },
  (table) => [index("sheets_folder_idx").on(table.folder, table.deletedAt)],
);

export const sheetTabs = pgTable(
  "sheet_tabs",
  {
    id: text("id").primaryKey(),
    sheetId: text("sheet_id")
      .notNull()
      .references(() => sheets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: bigint("position", { mode: "number" }).notNull(),
    rowCount: integer("row_count").notNull().default(0),
    colCount: integer("col_count").notNull().default(0),
    frozenRows: integer("frozen_rows").notNull().default(0),
    frozenCols: integer("frozen_cols").notNull().default(0),
    colWidths: jsonb<Record<string, number>>("col_widths"),
    deletedAt: timestamptz("deleted_at"),
  },
  (table) => [uniqueIndex("sheet_tabs_position_idx").on(table.sheetId, table.position)],
);

export const sheetCells = pgTable(
  "sheet_cells",
  {
    tabId: text("tab_id")
      .notNull()
      .references(() => sheetTabs.id, { onDelete: "cascade" }),
    row: integer("row").notNull(),
    col: integer("col").notNull(),
    value: text("value"),
    formula: text("formula"),
    format: jsonb<Record<string, unknown>>("format"),
    input: text("input").notNull().default(""),
    type: text("type"),
    error: text("error"),
  },
  (table) => [primaryKey({ columns: [table.tabId, table.row, table.col] })],
);

export const calendarCache = pgTable(
  "calendar_cache",
  {
    calendarId: text("calendar_id").notNull(),
    eventId: text("event_id").notNull(),
    startsAt: text("starts_at").notNull(),
    endsAt: text("ends_at"),
    data: jsonb<Record<string, unknown>>("data").notNull(),
    fetchedAt: timestamptz("fetched_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.calendarId, table.eventId] }),
    index("calendar_cache_range_idx").on(table.startsAt),
  ],
);
