type AudioContextConstructor = typeof AudioContext;

let context: AudioContext | null = null;

function audioContext() {
  if (context) return context;
  const Constructor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext);
  if (!Constructor) return null;
  context = new Constructor();
  return context;
}

/** Browsers keep audio locked until the person interacts with the page once. */
export function unlockAlertSound() {
  const ctx = audioContext();
  if (ctx?.state === 'suspended') void ctx.resume().catch(() => {});
}

/** A short two-note chime, made here so there is no audio file to ship. */
export function playAlertSound(kind: 'message' | 'handoff') {
  const ctx = audioContext();
  if (!ctx || ctx.state !== 'running') return;
  const notes = kind === 'handoff' ? [660, 880, 990] : [880, 1175];
  const start = ctx.currentTime + 0.01;
  notes.forEach((frequency, index) => {
    const at = start + index * 0.13;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.18, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.24);
  });
}
