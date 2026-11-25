// A small cancellable timeline: flows are plain async functions, and every
// wait rejects once the run is cancelled, so switching flows mid-animation
// never leaves stray timers mutating the screen.
export class Cancelled extends Error {}

export function runScript(body) {
  let dead = false;
  const timers = new Set();
  const rejects = new Set();
  const s = {
    alive: () => !dead,
    wait(ms) {
      if (dead) return Promise.reject(new Cancelled());
      return new Promise((resolve, reject) => {
        rejects.add(reject);
        const id = setTimeout(() => { timers.delete(id); rejects.delete(reject); resolve(); }, ms);
        timers.add(id);
      });
    },
  };
  const done = body(s).catch((e) => { if (!(e instanceof Cancelled) && e?.message !== 'cancelled') console.error(e); });
  const cancel = () => {
    dead = true;
    timers.forEach(clearTimeout);
    timers.clear();
    rejects.forEach((r) => r(new Cancelled()));
    rejects.clear();
  };
  return { cancel, done };
}

/** Human-ish typing cadence. */
export const typeDelay = (ch) => (ch === ' ' ? 80 : 38 + 46 * Math.random());
