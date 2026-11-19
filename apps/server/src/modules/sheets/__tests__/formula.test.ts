import { describe, expect, test } from "bun:test";
import { type BookTab, parseInput, parseRange, shiftFormula, toEngineFormula, Workbook } from "../services/formula";

function tab(id: string, name: string, cells: Record<string, string>): BookTab {
  const map = new Map();
  let rows = 0;
  let cols = 0;
  for (const [a, input] of Object.entries(cells)) {
    const c = a.charCodeAt(0) - 65;
    const r = Number(a.slice(1)) - 1;
    map.set(`${r},${c}`, { r, c, input, v: null, t: null });
    rows = Math.max(rows, r + 1);
    cols = Math.max(cols, c + 1);
  }
  return { id, name, rowCount: rows, colCount: cols, cells: map };
}

function compute(cells: Record<string, string>, other: Record<string, string> = {}) {
  const book = new Workbook([tab("t1", "Dados", cells), tab("t2", "Resumo", other)]).computeAll();
  return (tabId: string, a: string) => book.get(tabId)?.get(`${Number(a.slice(1)) - 1},${a.charCodeAt(0) - 65}`);
}

describe("formula engine", () => {
  test("portuguese and english functions with ; and decimal comma", () => {
    const at = compute(
      {
        A2: "jan",
        B2: "1.520,50",
        A3: "fev",
        B3: "200",
        A4: "mar",
        B4: "12%",
        C1: "=SOMA(B2:B4)",
        C2: "=MÉDIA(B2:B3)",
        C3: '=SE(B3>100;"alto";"baixo")',
        C4: '=PROCV("fev";A2:B4;2;FALSO)',
        C5: '=PROCX("mar";A2:A4;B2:B4)',
        C6: '=CONT.SE(B2:B4;">100")',
        C7: '=SOMASE(B2:B4;">100")',
        C8: "=MÁX(B2:B4)-MÍN(B2:B4)",
        C9: "=SUM(B2:B3)*1,5",
        D1: "=XLOOKUP(\"jan\",A2:A4,B2:B4)",
      },
      { A1: "=Dados!C1*2", A2: "='Dados'!B3+1" },
    );
    expect(at("t1", "C1")?.v).toBe(1720.62);
    expect(at("t1", "C2")?.v).toBe(860.25);
    expect(at("t1", "C3")?.v).toBe("alto");
    expect(at("t1", "C4")?.v).toBe(200);
    expect(at("t1", "C5")?.v).toBe(0.12);
    expect(at("t1", "C6")?.v).toBe(2);
    expect(at("t1", "C7")?.v).toBe(1720.5);
    expect(at("t1", "C8")?.v).toBe(1520.38);
    expect(at("t1", "C9")?.v).toBe(2580.75);
    expect(at("t1", "D1")?.v).toBe(1520.5);
    expect(at("t2", "A1")?.v).toBe(3441.24);
    expect(at("t2", "A2")?.v).toBe(201);
  });

  test("errors in portuguese", () => {
    const at = compute({ A1: "=1/0", A2: "=A3", A3: "=A2", A4: "=FOO(1)", A5: "=Nada!A1" });
    expect(at("t1", "A1")).toMatchObject({ v: "#DIV/0!", t: "e" });
    expect(at("t1", "A2")).toMatchObject({ v: "#CYCLE!", t: "e" });
    expect(at("t1", "A4")).toMatchObject({ v: "#NAME?", t: "e" });
    expect(at("t1", "A5")?.v).toBe("#REF!");
    expect(at("t1", "A5")?.error).toContain("não existe");
  });

  test("input parsing", () => {
    expect(parseInput("R$ 1.520,50")).toMatchObject({ v: 1520.5, t: "n", hint: { type: "brl" } });
    expect(parseInput("20/11/2026")).toMatchObject({ v: "2026-11-20", t: "d" });
    expect(parseInput("'=texto")).toMatchObject({ v: "=texto", t: "s" });
    expect(parseInput("VERDADEIRO")).toMatchObject({ v: true, t: "b" });
    expect(toEngineFormula('=SE(A1>1,5;"a;b";VERDADEIRO)')).toBe('IF(A1>1.5,"a;b",TRUE)');
    expect(parseRange("B:B")).toMatchObject({ c1: 1, c2: 1, r1: 0 });
  });

  test("structure rewrites references like Excel", () => {
    expect(shiftFormula("=SOMA(B2:B9)+$C$5+Resumo!A3", "Dados", "Dados", "insert_rows", 2, 2)).toBe(
      "=SOMA(B2:B11)+$C$7+Resumo!A3",
    );
    expect(shiftFormula("=SOMA(B2:B9)+B3+LOG10(4)", "Dados", "Dados", "delete_rows", 2, 1)).toBe(
      "=SOMA(B2:B8)+#REF!+LOG10(4)",
    );
    expect(shiftFormula("=Dados!A1+C1", "Resumo", "Dados", "insert_cols", 0, 1)).toBe("=Dados!B1+C1");
  });
});
