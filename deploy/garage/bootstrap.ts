import { chmod, chown, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = process.env.GARAGE_ROOT ?? "/var/lib/garage";
const secretsDir = join(root, "secrets");
const adminUrl = process.env.GARAGE_ADMIN_URL ?? "http://storage:3903";
const envFile = process.env.BOTS_ENV_FILE_PATH ?? "/repo/.env.local";
const bucketName = process.env.S3_BUCKET ?? "runelay-bots";
const keyName = process.env.GARAGE_KEY_NAME ?? "runelay-bots-server";
const capacity = Number(process.env.GARAGE_CAPACITY_GB ?? 100) * 1_000_000_000;
const uid = 1000;
const gid = 1000;

function randomHex(bytes: number) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

async function ensureSecret(name: string) {
  const file = Bun.file(join(secretsDir, name));
  if ((await file.exists()) && (await file.text()).trim()) return false;
  await Bun.write(file, randomHex(32));
  return true;
}

async function secrets() {
  for (const dir of [root, join(root, "meta"), join(root, "data"), secretsDir]) {
    await mkdir(dir, { recursive: true });
    await chown(dir, uid, gid);
  }
  await chmod(secretsDir, 0o700);
  for (const name of ["rpc_secret", "admin_token"]) {
    const created = await ensureSecret(name);
    const path = join(secretsDir, name);
    await chmod(path, 0o600);
    await chown(path, uid, gid);
    console.log(`${name}: ${created ? "created" : "kept"}`);
  }
}

async function admin<T>(token: string, method: "GET" | "POST", path: string, body?: unknown): Promise<T | null> {
  const response = await fetch(`${adminUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 404 || response.status === 400) {
    if (method === "GET") return null;
  }
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}`);
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

async function waitForAdmin(token: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const status = await admin<{ nodes: { id: string; isUp: boolean }[] }>(token, "GET", "/v2/GetClusterStatus");
      if (status?.nodes?.length) return status;
    } catch {}
    await Bun.sleep(1000);
  }
  throw new Error("garage admin api did not answer");
}

interface Layout {
  version: number;
  roles: { id: string }[];
  stagedRoleChanges: { id: string }[];
}

async function ensureLayout(token: string, nodeId: string) {
  const layout = await admin<Layout>(token, "GET", "/v2/GetClusterLayout");
  if (layout?.roles.some((role) => role.id === nodeId)) return "kept";
  if (!layout?.stagedRoleChanges.some((role) => role.id === nodeId)) {
    await admin(token, "POST", "/v2/UpdateClusterLayout", {
      roles: [{ id: nodeId, zone: "dc1", capacity, tags: ["runelay-bots"] }],
    });
  }
  await admin(token, "POST", "/v2/ApplyClusterLayout", { version: (layout?.version ?? 0) + 1 });
  return "applied";
}

async function ensureBucket(token: string) {
  const found = await admin<{ id: string }>(token, "GET", `/v2/GetBucketInfo?globalAlias=${bucketName}`);
  if (found) return { id: found.id, state: "kept" };
  const created = await admin<{ id: string }>(token, "POST", "/v2/CreateBucket", { globalAlias: bucketName });
  if (!created) throw new Error("bucket was not created");
  return { id: created.id, state: "created" };
}

interface KeyInfo {
  accessKeyId: string;
  secretAccessKey: string | null;
  name: string;
}

function parseEnv(text: string) {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match?.[1]) values.set(match[1], match[2]?.replace(/^["']|["']$/g, "") ?? "");
  }
  return values;
}

async function ensureKey(token: string, current: Map<string, string>) {
  const knownId = current.get("S3_ACCESS_KEY_ID");
  if (knownId) {
    const known = await admin<KeyInfo>(token, "GET", `/v2/GetKeyInfo?id=${knownId}&showSecretKey=true`);
    if (known?.secretAccessKey && known.secretAccessKey === current.get("S3_SECRET_ACCESS_KEY"))
      return { key: known, state: "kept" };
  }
  const byName = await admin<KeyInfo>(token, "GET", `/v2/GetKeyInfo?search=${keyName}&showSecretKey=true`);
  if (byName?.secretAccessKey) return { key: byName, state: "reused" };
  const created = await admin<KeyInfo>(token, "POST", "/v2/CreateKey", { name: keyName });
  if (!created?.secretAccessKey) throw new Error("key was not created");
  return { key: created, state: "created" };
}

async function writeEnv(text: string, updates: Record<string, string>) {
  const lines = text ? text.replace(/\n$/, "").split("\n") : [];
  for (const [name, value] of Object.entries(updates)) {
    const index = lines.findIndex((line) => new RegExp(`^\\s*${name}\\s*=`).test(line));
    if (index >= 0) lines[index] = `${name}=${value}`;
    else lines.push(`${name}=${value}`);
  }
  const next = `${lines.join("\n")}\n`;
  if (next === text) return false;
  const temp = `${envFile}.tmp`;
  await Bun.write(temp, next);
  await chmod(temp, 0o600);
  await rename(temp, envFile);
  return true;
}

async function setup() {
  const token = (await Bun.file(join(secretsDir, "admin_token")).text()).trim();
  const status = await waitForAdmin(token);
  const node = status.nodes.find((item) => item.isUp) ?? status.nodes[0];
  if (!node) throw new Error("no garage node");
  console.log(`layout: ${await ensureLayout(token, node.id)}`);
  const bucket = await ensureBucket(token);
  console.log(`bucket ${bucketName}: ${bucket.state}`);
  const envText = (await Bun.file(envFile).exists()) ? await Bun.file(envFile).text() : "";
  const { key, state } = await ensureKey(token, parseEnv(envText));
  console.log(`key ${keyName}: ${state}`);
  await admin(token, "POST", "/v2/AllowBucketKey", {
    bucketId: bucket.id,
    accessKeyId: key.accessKeyId,
    permissions: { read: true, write: true, owner: true },
  });
  const changed = await writeEnv(envText, {
    S3_ACCESS_KEY_ID: key.accessKeyId,
    S3_SECRET_ACCESS_KEY: key.secretAccessKey ?? "",
  });
  await chmod(envFile, 0o600);
  const owner = await stat(dirname(envFile));
  await chown(envFile, owner.uid, owner.gid);
  console.log(`env file: ${changed ? "updated" : "kept"}`);
}

const mode = process.argv[2];
if (mode === "secrets") await secrets();
else if (mode === "setup") await setup();
else throw new Error("usage: bootstrap.ts secrets|setup");
