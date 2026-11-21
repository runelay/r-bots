import { healthCommand } from "./health";
import { readEnv, startRunner } from "./runner";

async function main() {
  const runner = await startRunner(readEnv(process.env));
  process.on("SIGINT", () => runner.stop());
  process.on("SIGTERM", () => runner.stop());
  const reason = await runner.stopped;
  process.exit(reason === "stopped" ? 0 : 1);
}

if (process.argv[2] === "health") process.exit(healthCommand(process.env, (line) => console.log(line)));
void main();
