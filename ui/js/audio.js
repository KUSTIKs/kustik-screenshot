// Audio sources for recording, backed by the host (PulseAudio API on PipeWire).
//
// Microphones are listed by the host; while a mic is on and a recording can
// start, the host streams its level for the meters. System audio is an on/off
// preference (the host records the default output's monitor).

import { native } from './native.js';

export class AudioSources {
  constructor(onChange) {
    this.onChange = onChange;
    this.mic = { on: false, id: null, label: 'Microphone' };
    this.sys = { on: true };
    this.mics = [];
    this.permitted = true; // no browser permission prompt in the native app
    this.denied = false;
    this.monitoring = false;
    this.level = 0;
    this.target = 0;
    native.on('mic-level', (m) => { this.target = m.v; });
  }

  async refreshMics() {
    try {
      const { mics, default: def } = await native.call('list-mics');
      this.mics = mics;
      if (!this.mic.id) {
        const d = mics.find((m) => m.id === def) || mics[0];
        if (d) this.mic = { ...this.mic, id: d.id, label: d.label };
      }
    } catch (err) {
      console.warn('list-mics failed', err);
    }
    this.onChange();
  }

  /** Turn the mic on (optionally switching device) and start level metering. */
  async enableMic(id = this.mic.id) {
    if (!this.mics.length) await this.refreshMics();
    const m = this.mics.find((x) => x.id === id) || this.mics[0];
    if (!m) { this.denied = true; this.onChange(); return; }
    this.mic = { on: true, id: m.id, label: m.label };
    this.denied = false;
    this.monitor(true);
    this.onChange();
  }

  disableMic() {
    this.monitor(false);
    this.mic = { ...this.mic, on: false };
    this.onChange();
  }

  setSystem(on) {
    this.sys = { on };
    this.onChange();
  }

  monitor(on) {
    this.monitoring = on && this.mic.on;
    native.send('mic-monitor', { source: this.monitoring ? this.mic.id : null });
    if (!this.monitoring) this.target = 0;
  }

  /** Stop metering (keeps the on/off preference). */
  release() { if (this.monitoring) this.monitor(false); }

  /** Selected sources for the recorder. */
  sources() {
    return { mic: this.mic.on ? this.mic.id : null, sys: this.sys.on };
  }

  /** 0..1 loudness for the meters: fast attack, slow release. */
  tick() {
    const v = this.target;
    this.level = v > this.level ? v : this.level * 0.85 + v * 0.15;
    return this.level;
  }
}
