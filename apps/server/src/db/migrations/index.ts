import m0 from "./0000_init.sql" with { type: "file" };
import m1 from "./0001_search.sql" with { type: "file" };
import m2 from "./0002_usage_accounts.sql" with { type: "file" };
import m3 from "./0003_devices.sql" with { type: "file" };
import m4 from "./0004_message_reactions.sql" with { type: "file" };
import journal from "./meta/_journal.json";

export const migrationFiles: Record<string, string> = {
  "0000_init": m0,
  "0001_search": m1,
  "0002_usage_accounts": m2,
  "0003_devices": m3,
  "0004_message_reactions": m4,
};

export { journal };
