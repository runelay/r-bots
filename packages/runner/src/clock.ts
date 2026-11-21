import type { Clock } from "./types";

export const realClock: Clock = {
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(timer) };
  },
  every(ms, fn) {
    const timer = setInterval(fn, ms);
    return { cancel: () => clearInterval(timer) };
  },
};
