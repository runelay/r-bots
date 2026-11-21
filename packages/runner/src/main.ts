import { readEnv, startRunner } from "./runner";

const runner = await startRunner(readEnv(process.env));
process.on("SIGINT", () => runner.stop());
process.on("SIGTERM", () => runner.stop());
const reason = await runner.stopped;
process.exit(reason === "stopped" ? 0 : 1);
