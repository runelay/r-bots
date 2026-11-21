import "reflect-metadata";
import { installConsoleRedaction } from "./shared/redact";

for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CURSOR_API_KEY", "XAI_API_KEY"])
  delete Bun.env[key];

async function start(command: string | undefined) {
  if (command === "backup") {
    installConsoleRedaction();
    const { runBackupCommand } = await import("./backup-command");
    process.exit(await runBackupCommand());
  }
  const { main } = await import("./boot");
  await main();
}

void start(Bun.argv[2]);
