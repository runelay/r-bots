import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { waitFor } from "../../../../test/engine-helpers";
import { startTestJobs, type TestJobs } from "../../../../test/jobs-helpers";
import { getJobView, retryJob } from "../../jobs/services/jobs.service";
import { createNote } from "../../notes/services/notes.service";
import * as storage from "../../storage/services/storage.service";
import { createExport, exportBytes, readExport, renderExport } from "../services/exports.service";

setDefaultTimeout(30_000);

const bot = "bot-export-jobs";
let jobs: TestJobs;

beforeAll(async () => {
  jobs = await startTestJobs();
});

afterAll(async () => {
  await jobs.stop();
});

describe("exports through the queue", () => {
  test("renders the export in a job and answers when it is ready", async () => {
    const { note } = await createNote(bot, { title: "Fila", content: "# Oi\n\ncorpo" }, "bot");
    const job = await createExport(bot, { kind: "note", id: note.id, format: "md" });
    expect(job.status).toBe("ready");
    expect(await getJobView(`export-${job.id}`)).toMatchObject({ type: "export.render", status: "completed" });
    expect(new TextDecoder().decode((await exportBytes(bot, job.id)).data)).toBe("# Oi\n\ncorpo");
  });

  test("retries a failed render and marks the export failed on the last try", async () => {
    const { note } = await createNote(bot, { title: "Quebra", content: "x" }, "bot");
    const put = spyOn(storage, "putBlob").mockRejectedValueOnce(new Error("disco cheio"));
    try {
      const retried = await createExport(bot, { kind: "note", id: note.id, format: "md" });
      expect(retried).toMatchObject({ status: "ready", error: null });
      expect(await getJobView(`export-${retried.id}`)).toMatchObject({ attempts: 2 });
      put.mockRejectedValue(new Error("disco cheio"));
      const warn = spyOn(console, "warn").mockImplementation(() => undefined);
      const failed = await createExport(bot, { kind: "note", id: note.id, format: "md" });
      expect(failed).toMatchObject({ status: "failed", error: "disco cheio" });
      expect(await getJobView(`export-${failed.id}`)).toMatchObject({ status: "failed", attempts: 3 });
      expect(warn).toHaveBeenCalledWith(`export ${failed.id} falhou: disco cheio`);
      warn.mockRestore();
      await renderExport(bot, "exp_sumiu");
      put.mockRestore();
      await retryJob(`export-${failed.id}`);
      await waitFor(async () => (await readExport(bot, failed.id)).status === "ready");
      expect((await readExport(bot, failed.id)).error).toBeNull();
      await renderExport(bot, retried.id);
      expect((await exportBytes(bot, retried.id)).fileName).toBe("Quebra.md");
    } finally {
      put.mockRestore();
    }
  });
});
