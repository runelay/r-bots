import { afterAll, beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { fakeRunelay } from "../../../../test/fake-runelay";
import { startTestJobs, type TestJobs } from "../../../../test/jobs-helpers";
import { scheduledJobs } from "../../jobs/services/jobs.service";
import { refreshJobType, runRefreshJob, startConnectionsRefresh } from "../services/connections-jobs.service";
import * as runelay from "../services/runelay.service";

setDefaultTimeout(30_000);

let jobs: TestJobs;

beforeAll(async () => {
  jobs = await startTestJobs();
});

afterAll(async () => {
  await jobs.stop();
});

describe("connections refresh job", () => {
  test("registers a refresh every five minutes", async () => {
    await startConnectionsRefresh();
    await startConnectionsRefresh();
    const refresh = (await scheduledJobs()).filter((item) => item.key === refreshJobType);
    expect(refresh).toEqual([
      expect.objectContaining({ type: refreshJobType, pattern: "*/5 * * * *", timezone: null }),
    ]);
  });

  test("refreshes the connections from runelay and skips when runelay is off", async () => {
    let calls = 0;
    fakeRunelay.tool("list_connections", () => {
      calls++;
      return [{ name: "github", status: "connected" }];
    });
    expect(await runRefreshJob()).toEqual({ skipped: false });
    expect(calls).toBe(1);
    const off = spyOn(runelay, "runelayEnabled").mockReturnValue(false);
    try {
      expect(await runRefreshJob()).toEqual({ skipped: true });
    } finally {
      off.mockRestore();
    }
    expect(calls).toBe(1);
  });
});
