/** Plays a short two-tone chime, synthesized so there's no audio file to ship. */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "PAGE_CONNECT_CHIME") return;
  const ctx = new AudioContext();
  [880, 1175, 880, 1175].forEach((freq, i) => {
    const t = ctx.currentTime + i * 0.22;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.21);
  });
  setTimeout(() => void ctx.close(), 1500);
});
