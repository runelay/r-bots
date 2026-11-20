import { SQL } from "bun";

const url = process.env.TEST_DATABASE_URL ?? "postgres://runelay_bots:runelay_bots@127.0.0.1:55432/runelay_bots";
const container = process.env.TEST_POSTGRES_CONTAINER ?? "runelay-bots-pg-test";
const image = process.env.TEST_POSTGRES_IMAGE ?? "postgres:17-alpine";

async function reachable() {
  const sql = new SQL({ url, max: 1, connectionTimeout: 2 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.close();
  }
}

async function run(args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "ignore", stderr: "inherit" });
  return (await child.exited) === 0;
}

if (!(await reachable())) {
  if (process.env.TEST_DATABASE_URL) throw new Error(`TEST_DATABASE_URL is not reachable: ${new URL(url).host}`);
  const started =
    (await run(["start", container])) ||
    (await run([
      "run",
      "-d",
      "--name",
      container,
      "-p",
      "127.0.0.1:55432:5432",
      "-e",
      "POSTGRES_USER=runelay_bots",
      "-e",
      "POSTGRES_PASSWORD=runelay_bots",
      "-e",
      "POSTGRES_DB=runelay_bots",
      "--tmpfs",
      "/var/lib/postgresql/data",
      image,
      "-c",
      "max_connections=400",
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
    ]));
  if (!started) throw new Error("could not start the test postgres container");
  for (let attempt = 0; attempt < 60 && !(await reachable()); attempt++) await Bun.sleep(500);
  if (!(await reachable())) throw new Error("test postgres did not come up");
}
