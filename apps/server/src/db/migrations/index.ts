import m0 from "./0000_init.sql" with { type: "file" };
import m1 from "./0001_search.sql" with { type: "file" };
import journal from "./meta/_journal.json";

export const migrationFiles: Record<string, string> = {
  "0000_init": m0,
  "0001_search": m1,
};

export { journal };
