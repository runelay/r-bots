let watchers = 0;
let lastSeen = 0;

export function watchApp() {
  watchers++;
  lastSeen = Date.now();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    watchers--;
    lastSeen = Date.now();
  };
}

export function appWatching(graceMs = 60_000) {
  return watchers > 0 || Date.now() - lastSeen < graceMs;
}
