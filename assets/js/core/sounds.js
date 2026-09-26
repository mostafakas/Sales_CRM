// Short, quiet UI sounds made with WebAudio (no files to download). Each event has its own sound.
// Turned on by default; users can mute them from "My profile".
const KEY = 'am_sounds';
let ctx = null;
export const soundsOn = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } };
export const setSounds = (on) => { try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch {} };

function ac() {
  if (!ctx) { const A = window.AudioContext || window.webkitAudioContext; if (!A) return null; ctx = new A(); }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
// browsers only allow audio after the first click/key press on the page
['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, () => { try { ac(); } catch {} }, { once: true, passive: true }));

/** notes: [freqHz, startSec, durSec], soft sine envelope */
function tones(notes, { vol = 0.07, type = 'sine' } = {}) {
  const a = ac(); if (!a) return;
  const t0 = a.currentTime + 0.01;
  notes.forEach(([f, s, d]) => {
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t0 + s);
    g.gain.setValueAtTime(0.0001, t0 + s);
    g.gain.exponentialRampToValueAtTime(vol, t0 + s + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + s + d);
    o.connect(g).connect(a.destination);
    o.start(t0 + s); o.stop(t0 + s + d + 0.02);
  });
}

const SOUNDS = {
  send: () => tones([[740, 0, 0.07], [988, 0.05, 0.09]], { vol: 0.05 }),                   // quick upward blip
  receive: () => tones([[1175, 0, 0.08], [880, 0.07, 0.12]], { vol: 0.07 }),               // soft "pop"
  submit: () => tones([[660, 0, 0.06], [880, 0.06, 0.06], [1320, 0.12, 0.1]], { vol: 0.05 }), // request sent
  request: () => tones([[523, 0, 0.12], [784, 0.1, 0.18]], { vol: 0.08, type: 'triangle' }), // new request for me
  approved: () => tones([[523, 0, 0.08], [659, 0.07, 0.08], [784, 0.14, 0.16]], { vol: 0.07 }), // happy arpeggio
  rejected: () => tones([[440, 0, 0.12], [330, 0.1, 0.2]], { vol: 0.07, type: 'triangle' }), // low, falling
  info: () => tones([[880, 0, 0.1]], { vol: 0.05 })                                         // neutral tick
};
export function play(name) {
  if (!soundsOn()) return;
  try { (SOUNDS[name] || SOUNDS.info)(); } catch {}
}
