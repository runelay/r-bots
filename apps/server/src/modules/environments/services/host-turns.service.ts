import { AsyncLocalStorage } from "node:async_hooks";
import type { EnvironmentId, NativeToolHooks } from "@runelay-bots/protocol";

const store = new AsyncLocalStorage<EnvironmentId>();

export function onHost(hooks: NativeToolHooks, environment: EnvironmentId = "vps"): NativeToolHooks {
  return {
    before: (tool, input, toolUseId) => store.run(environment, () => hooks.before(tool, input, toolUseId)),
    after: (tool, input, response, toolUseId, failed) =>
      store.run(environment, () => hooks.after(tool, input, response, toolUseId, failed)),
  };
}

export function runningOnHost() {
  return store.getStore() !== undefined;
}

export function runningOnMac() {
  return store.getStore() === "mac";
}
