import { describe, expect, test } from "bun:test";
import { agendaBlockId, blockKinds, cellAddress, columnName, exportFormatsFor } from "../index";

describe("blocks", () => {
  test("lists the three block kinds and the agenda id", () => {
    expect([...blockKinds]).toEqual(["note", "sheet", "agenda"]);
    expect(agendaBlockId).toBe("agenda");
  });

  test("export formats depend on the kind", () => {
    expect([...exportFormatsFor("note")]).toEqual(["docx", "pdf", "md"]);
    expect([...exportFormatsFor("sheet")]).toEqual(["xlsx", "csv", "pdf"]);
  });

  test("column names follow the spreadsheet alphabet", () => {
    expect(columnName(0)).toBe("A");
    expect(columnName(25)).toBe("Z");
    expect(columnName(26)).toBe("AA");
    expect(columnName(701)).toBe("ZZ");
    expect(columnName(702)).toBe("AAA");
    expect(cellAddress(0, 0)).toBe("A1");
    expect(cellAddress(9, 27)).toBe("AB10");
  });
});
