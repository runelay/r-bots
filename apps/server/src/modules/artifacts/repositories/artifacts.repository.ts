import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { type Db, getDb, writeTransaction } from "../../../db";
import { artifacts, artifactVersions } from "../../../db/tables";
import type { ArtifactKind, ArtifactMeta } from "../services/artifacts.service";

export function artifactExtension(kind: string) {
  return kind === "canvas" ? "json" : "html";
}

export function artifactContentKey(botId: string, artifactId: string, version: number, kind: string) {
  return `bots/${botId}/artifacts/${artifactId}/v${version}.${artifactExtension(kind)}`;
}

async function assemble(rows: (typeof artifacts.$inferSelect)[], db: Db): Promise<ArtifactMeta[]> {
  if (!rows.length) return [];
  const versions = await db
    .select()
    .from(artifactVersions)
    .where(
      inArray(
        artifactVersions.artifactId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(artifactVersions.n));
  return rows.map((row) => ({
    id: row.id,
    botId: row.botId,
    title: row.title,
    kind: row.kind as ArtifactKind,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    versions: versions
      .filter((version) => version.artifactId === row.id)
      .map((version) => ({
        n: version.n,
        createdAt: version.createdAt,
        size: version.size,
        ...(version.author ? { author: version.author as "bot" | "user" } : {}),
      })),
    ...(row.canvas ? { canvas: row.canvas } : {}),
  }));
}

export async function readArtifactRow(botId: string, artifactId: string, db: Db = getDb()) {
  const [row] = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.botId, botId)))
    .limit(1);
  return row ? ((await assemble([row], db))[0] ?? null) : null;
}

export async function listArtifactRows(botId: string, db: Db = getDb()) {
  return assemble(
    await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.botId, botId))
      .orderBy(desc(artifacts.updatedAt), asc(artifacts.id)),
    db,
  );
}

export async function hasArtifactVersion(artifactId: string, version: number, db: Db = getDb()) {
  const [row] = await db
    .select({ n: artifactVersions.n })
    .from(artifactVersions)
    .where(and(eq(artifactVersions.artifactId, artifactId), eq(artifactVersions.n, version)))
    .limit(1);
  return Boolean(row);
}

export async function saveArtifactRow(meta: ArtifactMeta, db: Db = getDb()) {
  const row = {
    id: meta.id,
    botId: meta.botId,
    title: meta.title,
    kind: meta.kind,
    canvas: meta.canvas ?? null,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
  await writeTransaction(async (tx) => {
    await tx.insert(artifacts).values(row).onConflictDoUpdate({ target: artifacts.id, set: row });
    for (const version of meta.versions) {
      const values = {
        artifactId: meta.id,
        n: version.n,
        author: version.author ?? null,
        size: version.size,
        blobKey: artifactContentKey(meta.botId, meta.id, version.n, meta.kind),
        createdAt: version.createdAt,
      };
      await tx
        .insert(artifactVersions)
        .values(values)
        .onConflictDoUpdate({ target: [artifactVersions.artifactId, artifactVersions.n], set: values });
    }
  }, db);
}
