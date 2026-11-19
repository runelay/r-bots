import { describe, expect, test } from "bun:test";
import { address, type BookTab, colIndex, colLetters, errorMessage, excelFormula, excelSerial, maxCols, maxRows, parseAddress, parseInput, parseRange, quoteSheet, rangeText, renameSheetRefs, shiftFormula, toEngineFormula, Workbook } from "../services/formula";

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

describe("formula helpers", () => {
  test("number, money, percent, date and text inputs", () => {
    expect(parseInput("1,234.5")).toMatchObject({ v: 1234.5, t: "n" });
    expect(parseInput("1.234.567")).toMatchObject({ v: 1234567, t: "n" });
    expect(parseInput("3.5")).toMatchObject({ v: 3.5, t: "n" });
    expect(parseInput("1,2,3")).toMatchObject({ v: "1,2,3", t: "s" });
    expect(parseInput("-R$ 10,50")).toMatchObject({ v: -10.5, t: "n", hint: { type: "brl", decimals: 2 } });
    expect(parseInput("R$ muito")).toMatchObject({ v: "R$ muito", t: "s" });
    expect(parseInput("12,5%")).toMatchObject({ v: 0.125, t: "n", hint: { type: "percent" } });
    expect(parseInput("muito%")).toMatchObject({ v: "muito%", t: "s" });
    expect(parseInput("31/02/2026")).toMatchObject({ v: "31/02/2026", t: "s" });
    expect(parseInput("2026-03-04")).toMatchObject({ v: "2026-03-04", t: "d", hint: { type: "date" } });
    expect(parseInput("falso")).toMatchObject({ v: false, t: "b" });
    expect(parseInput("TRUE")).toMatchObject({ v: true, t: "b" });
    expect(parseInput("   ")).toMatchObject({ v: null, t: null, formula: null });
    expect(parseInput("=")).toMatchObject({ v: "=", t: "s" });
    expect(parseInput(" =A1 ")).toMatchObject({ formula: "=A1" });
  });

  test("addresses, ranges and column letters", () => {
    expect(colIndex("aa")).toBe(26);
    expect(colLetters(0)).toBe("A");
    expect(colLetters(701)).toBe("ZZ");
    expect(colLetters(702)).toBe("AAA");
    expect(address(9, 27)).toBe("AB10");
    expect(parseAddress(" $c$7 ")).toEqual({ r: 6, c: 2 });
    expect(() => parseAddress("7C")).toThrow("Endereço inválido: 7C");
    expect(() => parseAddress("A0")).toThrow("Endereço fora da planilha: A0");
    expect(() => parseAddress("A1048577")).toThrow("fora da planilha");
    expect(parseRange("D:B")).toEqual({ r1: 0, c1: 1, r2: maxRows - 1, c2: 3 });
    expect(parseRange("5:2")).toEqual({ r1: 1, c1: 0, r2: 4, c2: maxCols - 1 });
    expect(() => parseRange("0:3")).toThrow("Intervalo inválido: 0:3");
    expect(parseRange("C3:A1")).toEqual({ r1: 0, c1: 0, r2: 2, c2: 2 });
    expect(parseRange("B2")).toEqual({ r1: 1, c1: 1, r2: 1, c2: 1 });
    expect(rangeText({ r1: 1, c1: 1, r2: 1, c2: 1 })).toBe("B2");
    expect(rangeText({ r1: 0, c1: 0, r2: 2, c2: 3 })).toBe("A1:D3");
    expect(excelSerial("2026-01-02T10:00:00Z")).toBe(46024);
    expect(errorMessage("#WHAT")).toBe("Erro na fórmula.");
    expect(errorMessage("#N/A")).toBe("Valor não encontrado.");
  });

  test("engine translation keeps strings and only fixes top-level decimals", () => {
    expect(toEngineFormula("=1,5*2")).toBe("1.5*2");
    expect(toEngineFormula('=SUM(1,2)&"3,4"')).toBe('SUM(1,2)&"3,4"');
    expect(toEngineFormula("=soma(a1;falso;Verdadeiro)")).toBe("SUM(a1,FALSE,TRUE)");
    expect(toEngineFormula("=minhafunc(1)")).toBe("MINHAFUNC(1)");
    expect(excelFormula("  =SE(A1;1,5;2)  ")).toBe("IF(A1,1.5,2)");
    expect(quoteSheet("Dados")).toBe("Dados");
    expect(quoteSheet("Meu Mês")).toBe("'Meu Mês'");
    expect(quoteSheet("D'Ávila")).toBe("'D''Ávila'");
  });

  test("structure shifts cover ranges, columns, other tabs and strings", () => {
    expect(shiftFormula("texto A1", "Dados", "Dados", "insert_rows", 0, 1)).toBe("texto A1");
    expect(shiftFormula('=A5&"A5"', "Dados", "Dados", "insert_rows", 0, 2)).toBe('=A7&"A5"');
    expect(shiftFormula("=SOMA(A:A)+SOMA(3:4)", "Dados", "Dados", "insert_rows", 0, 1)).toBe("=SOMA(A:A)+SOMA(4:5)");
    expect(shiftFormula("=SOMA(3:4)+SOMA(B:C)", "Dados", "Dados", "insert_cols", 0, 1)).toBe("=SOMA(3:4)+SOMA(C:D)");
    expect(shiftFormula("=SOMA(A2:A4)+A1", "Dados", "Dados", "delete_rows", 1, 3)).toBe("=SOMA(#REF!)+A1");
    expect(shiftFormula("=SOMA(A3:A9)", "Dados", "Dados", "delete_rows", 1, 3)).toBe("=SOMA(A2:A6)");
    expect(shiftFormula("=SOMA(A1:A3)", "Dados", "Dados", "delete_rows", 1, 1)).toBe("=SOMA(A1:A2)");
    expect(shiftFormula("=A9+A1", "Dados", "Dados", "delete_rows", 2, 2)).toBe("=A7+A1");
    expect(shiftFormula("=$B$1+D1", "Dados", "Dados", "delete_cols", 1, 1)).toBe("=#REF!+C1");
    expect(shiftFormula("='Meu Mês'!A1+A1", "Dados", "Meu Mês", "insert_rows", 0, 1)).toBe("='Meu Mês'!A2+A1");
    expect(shiftFormula("=Outra!A1", "Dados", "Dados", "insert_rows", 0, 1)).toBe("=Outra!A1");
  });

  test("renaming a tab rewrites only references to it", () => {
    expect(renameSheetRefs("Dados!A1", "Dados", "Novo")).toBe("Dados!A1");
    expect(renameSheetRefs('=Dados!A1+dados!B2:C3+A1+Outra!A1&"Dados!A1"', "Dados", "Meu Mês")).toBe(
      "='Meu Mês'!A1+'Meu Mês'!B2:C3+A1+Outra!A1&\"Dados!A1\"",
    );
    expect(renameSheetRefs("='D''Ávila'!A1", "D'Ávila", "Final")).toBe("=Final!A1");
  });
});

describe("formula functions", () => {
  const cells = {
    A1: "1",
    A2: "2",
    A3: "3",
    A4: "x",
    A5: "",
    A6: "VERDADEIRO",
    B1: "a",
    B2: "b",
    B3: "ab",
    B4: "c",
    C1: "3",
    C2: "2",
    C3: "1",
    D1: "=MED(A1:A4)",
    D2: "=MED(A1:A2)",
    D3: "=MED()",
    D4: "=MAIOR(A1:A3;1)",
    D5: "=MENOR(A1:A3;2)",
    D6: "=MENOR(A1:A3;5)",
    D7: "=CONT.VALORES(A1:A6)",
    D8: "=CONTAR.VAZIO(A1:A6)",
    D9: '=CONT.SES(A1:A3;">1";B1:B3;"a*")',
    E1: '=SOMASES(A1:A3;B1:B3;"<>b")',
    E2: '=MEDIASES(A1:A3;B1:B3;"z")',
    E3: '=MEDIASES(A1:A3;B1:B3;"?b")',
    E4: '=CONT.SES(A1:A3;"<>2")',
    E5: '=CONT.SES(A1:A3;"<3")',
    E6: '=CONT.SES(A1:A3;"<=2")',
    E7: '=CONT.SES(A1:A3;">=2")',
    E8: '=CONT.SES(A1:A3;"=2")',
    E9: '=CONT.SES(B1:B4;">1")',
    F1: '=CONT.SES(A1:A6;"")',
    F2: "=CONT.SES(A1:A3;2)",
    F3: '=CONT.SES(B1:B4;"<>a.b")',
    F4: "=CONT.SES(A1:A3)",
    F5: '=CORRESP("AB";B1:B4;0)',
    F6: "=CORRESP(2,5;A1:A3;1)",
    F7: "=CORRESP(0;A1:A3)",
    F8: "=CORRESP(2;C1:C3;-1)",
    F9: '=CORRESP("zz";B1:B4;0)',
    G1: "=CORRESP(2;A1:A3;0)",
    G2: "=CORRESP(9;A1:A5;1)",
    G3: '=MAIUSCULA("ção")',
    G4: '=VALOR("1.234,5")',
    G5: '=VALOR("abc")',
    G6: "=VALOR(5)",
    G7: '=PROCX("zz";B1:B4;A1:A4)',
    G8: '=PROCX("zz";B1:B4;A1:A4;"nada")',
    G9: '=PROCX("B";B1:B4;A1:A4)',
    H1: '=MAX("3";VERDADEIRO;"x")',
    H2: "=MIN(A4)",
    H3: "=MAX(A4)",
    H4: "=MAX(1/0)",
    H5: "=10^400",
    H6: "=1=1",
    H7: "=A99",
    H8: '=SOMA(1;"x")',
    H9: "=SE(",
    I1: "02/01/2026",
    I2: "=I1+1",
    I3: '=SEERRO(1/0;"ok")',
    I4: "=MIN(C1:C3;FALSO)",
    I5: "=PROCX(2;A1:A3;B1:B3)",
  };
  const at = compute(cells);
  const value = (a: string) => at("t1", a)?.v;

  test("median, k-th and counts", () => {
    expect(value("D1")).toBe(2);
    expect(value("D2")).toBe(1.5);
    expect(at("t1", "D3")).toMatchObject({ v: "#NUM!", t: "e" });
    expect(value("D4")).toBe(3);
    expect(value("D5")).toBe(2);
    expect(value("D6")).toBe("#NUM!");
    expect(value("D7")).toBe(5);
    expect(value("D8")).toBe(1);
  });

  test("multi-criteria functions honour every operator", () => {
    expect(value("D9")).toBe(1);
    expect(value("E1")).toBe(4);
    expect(at("t1", "E2")).toMatchObject({ v: "#DIV/0!", t: "e" });
    expect(value("E3")).toBe(3);
    expect(value("E4")).toBe(2);
    expect(value("E5")).toBe(2);
    expect(value("E6")).toBe(2);
    expect(value("E7")).toBe(2);
    expect(value("E8")).toBe(1);
    expect(value("E9")).toBe(0);
    expect(value("F1")).toBe(1);
    expect(value("F2")).toBe(1);
    expect(value("F3")).toBe(4);
    expect(value("F4")).toBe(0);
  });

  test("match, lookup, upper and value", () => {
    expect(value("F5")).toBe(3);
    expect(value("F6")).toBe(2);
    expect(value("F7")).toBe("#N/A");
    expect(value("F8")).toBe(2);
    expect(value("F9")).toBe("#N/A");
    expect(value("G1")).toBe(2);
    expect(value("G2")).toBe(3);
    expect(value("G3")).toBe("ÇÃO");
    expect(value("G4")).toBe(1234.5);
    expect(at("t1", "G5")).toMatchObject({ v: "#VALUE!", t: "e" });
    expect(value("G6")).toBe(5);
    expect(value("G7")).toBe("#N/A");
    expect(value("G8")).toBe("nada");
    expect(value("G9")).toBe(2);
    expect(value("I5")).toBe("b");
  });

  test("max/min coercion, errors and result types", () => {
    expect(value("H1")).toBe(3);
    expect(value("H2")).toBe(0);
    expect(value("H3")).toBe(0);
    expect(value("H4")).toBe("#DIV/0!");
    expect(at("t1", "H5")).toMatchObject({ v: "#NUM!", t: "e", error: "Número inválido no cálculo." });
    expect(at("t1", "H6")).toMatchObject({ v: true, t: "b" });
    expect(at("t1", "H7")).toMatchObject({ v: 0, t: "n" });
    expect(at("t1", "H8")).toMatchObject({ v: "#VALUE!", t: "e" });
    expect(at("t1", "H9")).toMatchObject({ v: "#ERROR!", t: "e", error: "A fórmula não pôde ser lida." });
    expect(value("I2")).toBe(46025);
    expect(value("I3")).toBe("ok");
    expect(value("I4")).toBe(0);
  });

  test("an error in a referenced cell flows into dependents and cycles stay cycles", () => {
    const book = compute({ A1: "=1/0", A2: "=A1+1", B1: "=B2", B2: "=B3", B3: "=B1", C1: "=B1+1" });
    expect(book("t1", "A2")?.v).toBe("#DIV/0!");
    expect(book("t1", "B1")?.v).toBe("#CYCLE!");
    expect(book("t1", "B2")?.v).toBe("#CYCLE!");
    expect(book("t1", "C1")?.v).toBe("#CYCLE!");
  });

  test("array results collapse to the first value and unreadable input is #ERROR!", () => {
    const book = compute({ A1: "1", A2: "2", B1: "=A1:A2", B2: "=)" });
    expect(book("t1", "B1")?.v).toBe(1);
    expect(book("t1", "B2")).toMatchObject({ v: "#ERROR!", t: "e" });
  });
});
