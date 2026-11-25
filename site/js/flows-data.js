// The demo's steps, in order. `scene` picks the desktop's focused window;
// `dur` (ms) is about how long the step plays (the recorder's time limit is
// based on it); the caption is two-tone: a short lead, then the rest in grey.
export const STEPS = [
  { key: 'screenshot/area', label: 'Screenshot', scene: 'browser', dur: 9500,
    lead: 'Select anything.', text: 'Drag an area or click a window, press Enter, and it’s copied.' },
  { key: 'annotate/arrow', label: 'Annotate', scene: 'browser', dur: 14500,
    lead: 'Point it out.', text: 'Arrows, text, highlights and pixelate, right on the frozen screen.' },
  { key: 'record/area', label: 'Record', scene: 'terminal', dur: 15000,
    lead: 'Record a part of the screen.', text: 'The controls stay out of the video. Stop, and it’s copied.' },
  { key: 'trim/gif', label: 'GIF', scene: 'terminal', dur: 24000,
    lead: 'Trim it, share it.', text: 'Drag the ends, choose GIF, paste it anywhere.' },
];
