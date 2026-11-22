import { AsyncLocalStorage } from "node:async_hooks";
import type { NativeToolHooks } from "@runelay-bots/protocol";

const store = new AsyncLocalStorage<true>();

export function onHost(hooks: NativeToolHooks): NativeToolHooks {
  return {
    before: (tool, input, toolUseId) => store.run(true, () => hooks.before(tool, input, toolUseId)),
    after: (tool, input, response, toolUseId, failed) =>
      store.run(true, () => hooks.after(tool, input, response, toolUseId, failed)),
  };
}

export function runningOnHost() {
  return store.getStore() === true;
}
