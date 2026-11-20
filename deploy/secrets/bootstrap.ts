import { chmod, chown, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.BOTS_DATA_ROOT ?? "/data";
const uid = Number(process.env.BOTS_UID ?? 1000);
const gid = Number(process.env.BOTS_GID ?? 1000);
const secretsDir = join(root, "secrets");

function randomHex(bytes: number) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

async function ensureDir(path: string) {
  await mkdir(path, { recursive: true });
  await chown(path, uid, gid);
  await chmod(path, 0o700);
}

async function ensureSecret(name: string) {
  const path = join(secretsDir, name);
  const file = Bun.file(path);
  const created = !((await file.exists()) && (await file.text()).trim());
  if (created) await Bun.write(path, randomHex(32));
  await chmod(path, 0o600);
  await chown(path, uid, gid);
  console.log(`${name}: ${created ? "created" : "kept"}`);
}

await mkdir(root, { recursive: true });
if ((await stat(root)).uid === 0) await chown(root, uid, gid);
for (const dir of [secretsDir, join(root, "postgres"), join(root, "redis")]) await ensureDir(dir);
for (const name of ["postgres.password", "postgres-app.password", "redis.password"]) await ensureSecret(name);
