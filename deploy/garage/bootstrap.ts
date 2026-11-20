import { chmod, chown, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.GARAGE_ROOT ?? "/var/lib/garage";
const secretsDir = join(root, "secrets");
const adminUrl = process.env.GARAGE_ADMIN_URL ?? "http://storage:3903";
const dataSecretsDir = process.env.BOTS_SECRETS_DIR ?? "/data/secrets";
const accessKeyFile = join(dataSecretsDir, "s3.access-key-id");
const secretKeyFile = join(dataSecretsDir, "s3.secret-access-key");
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

async function readText(path: string) {
  const file = Bun.file(path);
  return (await file.exists()) ? (await file.text()).trim() : "";
}

async function ensureKey(token: string) {
  const knownId = await readText(accessKeyFile);
  if (knownId) {
    const known = await admin<KeyInfo>(token, "GET", `/v2/GetKeyInfo?id=${knownId}&showSecretKey=true`);
    if (known?.secretAccessKey && known.secretAccessKey === (await readText(secretKeyFile)))
      return { key: known, state: "kept" };
  }
  const byName = await admin<KeyInfo>(token, "GET", `/v2/GetKeyInfo?search=${keyName}&showSecretKey=true`);
  if (byName?.secretAccessKey) return { key: byName, state: "reused" };
  const created = await admin<KeyInfo>(token, "POST", "/v2/CreateKey", { name: keyName });
  if (!created?.secretAccessKey) throw new Error("key was not created");
  return { key: created, state: "created" };
}

async function writeSecret(path: string, value: string) {
  if ((await readText(path)) === value) return false;
  const temp = `${path}.tmp`;
  await Bun.write(temp, value);
  await chmod(temp, 0o600);
  await chown(temp, uid, gid);
  await rename(temp, path);
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
  const { key, state } = await ensureKey(token);
  console.log(`key ${keyName}: ${state}`);
  await admin(token, "POST", "/v2/AllowBucketKey", {
    bucketId: bucket.id,
    accessKeyId: key.accessKeyId,
    permissions: { read: true, write: true, owner: true },
  });
  await mkdir(dataSecretsDir, { recursive: true });
  await chmod(dataSecretsDir, 0o700);
  await chown(dataSecretsDir, uid, gid);
  const wroteId = await writeSecret(accessKeyFile, key.accessKeyId);
  const wroteSecret = await writeSecret(secretKeyFile, key.secretAccessKey ?? "");
  console.log(`storage keys: ${wroteId || wroteSecret ? "written" : "kept"}`);
}

const mode = process.argv[2];
if (mode === "secrets") await secrets();
else if (mode === "setup") await setup();
else throw new Error("usage: bootstrap.ts secrets|setup");
