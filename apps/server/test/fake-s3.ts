interface StoredObject {
  body: Uint8Array;
  type: string;
  modified: Date;
}

export function startFakeS3(bucket: string) {
  const objects = new Map<string, StoredObject>();
  const parts = new Map<string, Map<number, Uint8Array>>();
  const types = new Map<string, string>();
  let uploads = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const prefix = `/${bucket}`;
      if (!url.pathname.startsWith(prefix)) return new Response("no bucket", { status: 404 });
      const key = decodeURIComponent(url.pathname.slice(prefix.length + 1));
      const params = url.searchParams;
      if (request.method === "GET" && params.get("list-type") === "2") {
        const wanted = params.get("prefix") ?? "";
        const max = Number(params.get("max-keys") ?? 1000);
        const start = params.get("continuation-token");
        const keys = [...objects.keys()].filter((item) => item.startsWith(wanted)).sort();
        const from = start ? keys.indexOf(start) : 0;
        const page = keys.slice(from, from + max);
        const next = keys[from + max];
        const items = page
          .map((item) => {
            const object = objects.get(item) as StoredObject;
            return `<Contents><Key>${item}</Key><Size>${object.body.byteLength}</Size><LastModified>${object.modified.toISOString()}</LastModified></Contents>`;
          })
          .join("");
        const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><KeyCount>${page.length}</KeyCount><IsTruncated>${next ? "true" : "false"}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}${items}</ListBucketResult>`;
        return new Response(xml, { headers: { "content-type": "application/xml" } });
      }
      if (request.method === "POST" && params.has("uploads")) {
        const id = `u${++uploads}`;
        parts.set(id, new Map());
        types.set(id, request.headers.get("content-type") ?? "");
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      if (request.method === "PUT" && params.has("partNumber")) {
        const id = params.get("uploadId") as string;
        parts.get(id)?.set(Number(params.get("partNumber")), new Uint8Array(await request.arrayBuffer()));
        return new Response("", { headers: { etag: `"p${params.get("partNumber")}"` } });
      }
      if (request.method === "POST" && params.has("uploadId")) {
        const id = params.get("uploadId") as string;
        const stored = parts.get(id) as Map<number, Uint8Array>;
        const type = types.get(id) ?? "";
        const chunks = [...stored.entries()].sort(([a], [b]) => a - b);
        const body = new Uint8Array(await new Blob(chunks.map(([, chunk]) => chunk)).arrayBuffer());
        objects.set(key, { body, type, modified: new Date() });
        parts.delete(id);
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult><Key>${key}</Key><ETag>"x"</ETag></CompleteMultipartUploadResult>`,
        );
      }
      if (request.method === "PUT") {
        objects.set(key, {
          body: new Uint8Array(await request.arrayBuffer()),
          type: request.headers.get("content-type") ?? "",
          modified: new Date(),
        });
        return new Response("", { headers: { etag: '"x"' } });
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      const object = objects.get(key);
      if (!object)
        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>`,
          { status: 404, headers: { "content-type": "application/xml" } },
        );
      const headers = {
        "content-type": object.type,
        "content-length": String(object.body.byteLength),
        "last-modified": object.modified.toUTCString(),
        etag: '"x"',
      };
      if (request.method === "HEAD") return new Response(null, { headers });
      return new Response(object.body, { headers });
    },
  });
  return { server, objects, endpoint: `http://127.0.0.1:${server.port}` };
}
