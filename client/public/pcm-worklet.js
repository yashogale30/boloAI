// Runs on the audio thread: converts the mic stream to 16 kHz mono 16-bit PCM
// and posts it to the page in 100 ms frames.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000; // sampleRate is the AudioContext rate (usually 48000)
    this.frame = new Int16Array(1600);
    this.n = 0;
    this.pos = 0; // fractional read position carried across blocks
    this.acc = 0;
    this.accN = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // Box-filter downsampling: average the input samples that fall into each output sample.
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.accN++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const s = Math.max(-1, Math.min(1, this.acc / this.accN));
        this.acc = 0;
        this.accN = 0;
        this.frame[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.frame.length) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
          this.frame = new Int16Array(1600);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
