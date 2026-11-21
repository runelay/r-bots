import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { freshDb } from "../../../../test/db-helpers";
import { runMigrations } from "../../../db";
import { journal, migrationFiles } from "../../../db/migrations";

describe("0003_devices migration", () => {
  test("copies device identity from old key metadata and gives old keys an expiry", async () => {
    const db = await freshDb({ migrate: false });
    const before = journal.entries.filter((entry) => entry.tag < "0003_devices");
    const through = journal.entries.filter((entry) => entry.tag <= "0003_devices");
    await runMigrations(db, before, migrationFiles);
    const now = "2026-11-01T10:00:00.000Z";
    await db.execute(
      sql.raw(
        `insert into "user" (id, name, email, created_at, updated_at) values ('u1', 'Dona', 'd@x.co', '${now}', '${now}')`,
      ),
    );
    const key = (id: string, name: string, metadata: string | null, reference = "u1") =>
      db.execute(
        sql`insert into apikey (id, name, reference_id, key, created_at, updated_at, metadata) values (${id}, ${name}, ${reference}, ${`hash-${id}`}, ${now}, ${now}, ${metadata})`,
      );
    await key(
      "k1",
      "device",
      JSON.stringify({
        kind: "device",
        deviceId: "dev-1",
        name: "MacBook",
        model: "Mac15,12",
        machineId: "m1",
        registeredAt: "2026-10-01T00:00:00.000Z",
      }),
    );
    await key("k2", "device", JSON.stringify(JSON.stringify({ kind: "device", deviceId: "dev-2" })));
    await key("k3", "device", "{broken");
    await key("k4", "device", JSON.stringify({ kind: "runner" }));
    await key("k5", "mac-runner", JSON.stringify({ kind: "device", deviceId: "dev-5" }));
    await key("k6", "device", JSON.stringify({ kind: "device", deviceId: "dev-6", registeredAt: "nope" }));
    await key("k7", "device", JSON.stringify({ kind: "device", deviceId: "dev-7" }), "ghost");
    expect(await runMigrations(db, through, migrationFiles)).toEqual(["0003_devices"]);
    const devices = await db.execute<{ id: string; api_key_id: string; name: string; model: string | null }>(
      sql`select id, api_key_id, name, model, machine_id, registered_at from device order by id`,
    );
    expect(devices.map((row) => [row.id, row.api_key_id, row.name, row.model])).toEqual([
      ["dev-1", "k1", "MacBook", "Mac15,12"],
      ["dev-2", "k2", "Mac", null],
    ]);
    const open = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from apikey where expires_at is null`,
    );
    expect(open[0]?.count).toBe("0");
  });
});
