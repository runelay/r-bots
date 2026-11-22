import { healthCommand } from "./health";
import { startHostRunner } from "./host-runner";
import { readEnv, startRunner } from "./runner";

async function main() {
  const config = readEnv(process.env);
  const runner = config.provider === "host" ? await startHostRunner(config) : await startRunner(config);
  process.on("SIGINT", () => runner.stop());
  process.on("SIGTERM", () => runner.stop());
  const reason = await runner.stopped;
  process.exit(reason === "stopped" ? 0 : 1);
}

if (process.argv[2] === "health") process.exit(healthCommand(process.env, (line) => console.log(line)));
void main();
