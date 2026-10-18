// Smart streaming for screen shares.
// - Specs: a quick local look at this computer (graphics card, processor, memory)
//   picks the quality a stream starts at. Nothing leaves the computer.
// - Adapt: every 2 s it checks what the stream really does. When a moving picture
//   goes out at under 60% of its frame rate, or your upload can't carry the
//   current size, for 6 s, it steps down one level (1440p60, 1080p60, 900p60,
//   720p60, 720p30, 540p30), and back up once things have been smooth for a
//   while, never above what you chose in Settings.
// - Stream info: the sender shares those numbers with the people watching, so
//   right-click a stream > Stream info shows why it stutters.
'use strict';

// mbps: about what each level needs from your upload to look clean. On a slower
// line a smaller picture looks sharper than a starved big one.
const LEVELS = [
  { h: 2160, fps: 60, mbps: 20 }, { h: 1440, fps: 60, mbps: 9 }, { h: 1080, fps: 60, mbps: 5 }, { h: 900, fps: 60, mbps: 3.5 },
  { h: 720, fps: 60, mbps: 2.5 }, { h: 720, fps: 30, mbps: 1.5 }, { h: 540, fps: 30, mbps: 0.8 },
];
const levelName = (i) => `${LEVELS[i].h}p ${LEVELS[i].fps} fps`;

// What you picked in Settings > Video is the most the stream goes up to.
function ceilingLevel() {
  const h = settings.shareRes === 'native' ? 2160 : Number(settings.shareRes);
  const fps = Number(settings.shareFps);
  const i = LEVELS.findIndex((l) => l.h <= h && l.fps <= fps);
  return i < 0 ? LEVELS.length - 1 : i;
}

// ------------------------------------------------------------------ specs
const Specs = {
  info: null,

  async scan() {
    const desk = window.miserecordDesktop;
    if (!desk || !desk.systemInfo) return null;
    try {
      const info = await desk.systemInfo();
      info.start = recommendLevel(info);
      this.info = info;
      Log.info('media', 'this computer', { gpus: info.gpus.map((g) => g.name).join(' + '), threads: info.threads, ramGB: info.ramGB, startsAt: levelName(info.start) });
      return info;
    } catch (err) {
      Log.warn('media', 'could not read this computer\'s specs', err);
      return null;
    }
  },

  // The main graphics card: a separate NVIDIA, AMD or Intel Arc card if there is one.
  discrete() {
    if (!this.info) return null;
    return this.info.gpus.find((g) => g.vendor === 'NVIDIA'
      || (g.vendor === 'AMD' && !/Radeon\(TM\) Graphics|Radeon Graphics$|Vega \d+/i.test(g.name))
      || (g.vendor === 'Intel' && /Arc/i.test(g.name))) || null;
  },
};

// A desktop graphics card starts at 1440p60; a gaming laptop, where the game and
// the stream share one card (and usually a busy processor), at 1080p60; built-in
// graphics only at 720p.
function recommendLevel(info) {
  const gpu = Specs.discrete.call({ info });
  const laptop = info.gpus.some((g) => /laptop|mobile|max-q/i.test(g.name));
  if (gpu && !laptop) return 1;
  if (gpu) return 2;
  return info.threads >= 8 ? 4 : 5;
}

// ------------------------------------------------------------------ adapt
const Adapt = {
  track: null,
  level: null,
  ceiling: 0,
  bad: 0,
  good: 0,
  changedAt: 0,
  steppedUpAt: 0,
  holdUp: false, // it stuttered right after stepping up: stay put for this share
  told: false,
  hinted: false,
  prev: new Map(), // per peer: last bytes and frames, for per-frame size

  start(track) {
    this.track = track;
    this.ceiling = ceilingLevel();
    const start = settings.adaptive && Specs.info ? Math.max(this.ceiling, Specs.info.start) : this.ceiling;
    this.level = start;
    this.bad = 0; this.good = 0; this.changedAt = Date.now(); this.steppedUpAt = 0;
    this.holdUp = false; this.told = false; this.hinted = false; this.prev.clear();
    this.apply(start === this.ceiling ? 'start' : 'start, suited to this computer');
  },

  stop() {
    this.track = null;
    this.level = null;
    state.sendStats = null;
  },

  // You changed the quality yourself: start again from your choice.
  reset() {
    if (!this.track) return;
    this.ceiling = ceilingLevel();
    this.level = this.ceiling;
    this.bad = 0; this.good = 0; this.holdUp = false; this.changedAt = Date.now();
    this.apply('quality changed by you');
  },

  fps() {
    return this.level != null ? LEVELS[this.level].fps : Number(settings.shareFps);
  },

  apply(reason) {
    const l = LEVELS[this.level];
    const w = Math.round((l.h * 16) / 9);
    Log.info('media', `stream quality ${levelName(this.level)}`, reason);
    this.track.applyConstraints({
      width: { ideal: w, max: w },
      height: { ideal: l.h, max: l.h },
      frameRate: { ideal: l.fps, max: l.fps },
    }).catch((err) => Log.warn('media', 'could not change the stream quality', err));
    applySendParams();
  },

  // Called every 2 s during a call.
  async tick() {
    const s = state.screen;
    if (!s || !this.track || this.level == null) return;
    const now = Date.now();
    let worst = null;
    let upload = Infinity; // Mbps the slowest connection can carry, as WebRTC estimates it
    for (const peer of state.peers.values()) {
      if (peer.pc.connectionState !== 'connected') continue;
      const stats = await peer.pc.getStats();
      stats.forEach((r) => {
        if (r.type !== 'transport' || !r.selectedCandidatePairId) return;
        const pair = stats.get(r.selectedCandidatePairId);
        if (pair && pair.availableOutgoingBitrate) upload = Math.min(upload, pair.availableOutgoingBitrate / 1e6);
      });
      stats.forEach((r) => {
        if (r.type !== 'outbound-rtp' || r.kind !== 'video' || !r.frameWidth) return;
        const codec = r.codecId && stats.get(r.codecId);
        const src = r.mediaSourceId && stats.get(r.mediaSourceId);
        const p = this.prev.get(peer.id);
        this.prev.set(peer.id, { bytes: r.bytesSent, frames: r.framesEncoded || 0 });
        const frames = p ? (r.framesEncoded || 0) - p.frames : 0;
        const sample = {
          size: `${r.frameWidth}×${r.frameHeight}`,
          capture: src && src.framesPerSecond != null ? Math.round(src.framesPerSecond) : null,
          sent: Math.round(r.framesPerSecond || 0),
          bytesPerFrame: p && frames > 0 ? (r.bytesSent - p.bytes) / frames : 0,
          limit: r.qualityLimitationReason || 'none',
          codec: codec ? codec.mimeType.replace('video/', '') : '',
          gpu: r.powerEfficientEncoder === true,
        };
        if (!worst || sample.sent < worst.sent) worst = sample;
      });
    }
    if (!worst) return;
    if (!Number.isFinite(upload)) upload = null;
    const want = LEVELS[this.level].fps;
    const viewers = [...state.peers.values()].filter((p) => p.pc.connectionState === 'connected').length;
    // Only when the encoder is actually held back by the line: a still screen sends
    // little, so the estimate stays low without anything being wrong.
    const starved = worst.limit === 'bandwidth' && upload != null && upload < LEVELS[this.level].mbps * 0.6;
    // A still desktop sends few, small frames on purpose; a game sends big ones.
    const busy = worst.bytesPerFrame > 12000;
    let diagnosis = 'ok';
    if (starved) diagnosis = 'bandwidth';
    else if (worst.sent < want * 0.85) {
      if (!busy) diagnosis = 'still';
      else if (worst.capture != null && worst.capture < want * 0.6 && worst.sent >= worst.capture * 0.8) diagnosis = 'capture';
      else if (worst.limit === 'bandwidth') diagnosis = 'bandwidth';
      else diagnosis = 'encoder';
    }
    const report = { ...worst, want, upload: upload != null ? Math.round(upload * 10) / 10 : null, viewers, level: levelName(this.level), auto: !!settings.adaptive, diagnosis };
    state.sendStats = report;
    broadcast({ type: 'stream-stats', id: s.stream.id, stats: report });
    refreshStreamInfo();

    if (!settings.adaptive) return;
    const struggling = starved || (busy && worst.sent < want * 0.6);
    this.bad = struggling ? this.bad + 1 : 0;
    // Going up needs room for the next level, not just the current one.
    const roomUp = this.level === 0 || upload == null || upload >= LEVELS[this.level - 1].mbps * 1.2;
    this.good = (diagnosis === 'ok' || diagnosis === 'still') && roomUp ? this.good + 1 : 0;

    // Each change gets 10 s to settle before the stream is judged again.
    if (this.bad >= 3 && now - this.changedAt > 10000 && this.level < LEVELS.length - 1) {
      if (this.steppedUpAt && now - this.steppedUpAt < 20000) this.holdUp = true;
      this.level += 1;
      this.bad = 0; this.good = 0; this.changedAt = now;
      this.apply(`struggling: ${worst.sent} of ${want} fps, ${diagnosis}`);
      if (!this.told) {
        this.told = true;
        toast(`Your stream was struggling, so it's now ${levelName(this.level)}.`);
      }
      if (diagnosis === 'bandwidth' && !this.hinted) {
        this.hinted = true;
        setTimeout(() => toast(`Your upload carries about ${report.upload} Mbps right now, so the stream is smaller to stay sharp. A cable instead of Wi-Fi usually helps.`), 5000);
      }
      if (diagnosis === 'capture' && !this.hinted) {
        this.hinted = true;
        setTimeout(() => toast("Windows is handing over few frames, usually because the game uses the whole graphics card. Capping the game's frame rate (V-Sync, or 120 fps) frees room for your stream."), 5000);
      }
    } else if (this.good >= 15 && this.level > this.ceiling && !this.holdUp && now - this.changedAt > 30000) {
      this.level -= 1;
      this.good = 0; this.changedAt = now; this.steppedUpAt = now;
      this.apply('smooth for 30 s, trying one level up');
    }
  },
};

// ------------------------------------------------------------------ stream info
const DIAGNOSIS = {
  ok: 'Running smoothly',
  still: 'Little is moving, so few frames are needed',
  capture: 'Windows is handing over few frames: the game is probably using the whole graphics card',
  encoder: "The encoder can't keep up",
  bandwidth: "The sender's upload is too slow for this size",
};

function toggleStreamInfo(tileEl) {
  let box = tileEl.querySelector('.stream-info');
  if (box) { box.remove(); return; }
  box = document.createElement('div');
  box.className = 'stream-info';
  tileEl.querySelector('.video-wrap').append(box);
  refreshStreamInfo();
}

// Fill every open Stream info box: what the sender reports, and what arrives here.
async function refreshStreamInfo() {
  for (const box of document.querySelectorAll('.stream-info')) {
    const tile = box.closest('.tile');
    let send = null;
    let recv = '';
    if (tile.classList.contains('remote')) {
      for (const peer of state.peers.values()) {
        for (const entry of peer.remote.values()) {
          if (!entry.tile || entry.tile.el !== tile) continue;
          send = entry.senderStats || null;
          const trackId = entry.stream.getVideoTracks()[0] && entry.stream.getVideoTracks()[0].id;
          const stats = await peer.pc.getStats().catch(() => null);
          if (stats) stats.forEach((r) => {
            if (r.type !== 'inbound-rtp' || r.kind !== 'video' || (trackId && r.trackIdentifier !== trackId)) return;
            const prev = entry.recvPrev;
            const t = performance.now();
            entry.recvPrev = { bytes: r.bytesReceived, t };
            const mbps = prev ? ((r.bytesReceived - prev.bytes) * 8) / ((t - prev.t) / 1000) / 1e6 : null;
            recv = [`${Math.round(r.framesPerSecond || 0)} fps`, mbps != null ? `${mbps.toFixed(1)} Mbps` : '', `${r.framesDropped || 0} frames dropped`].filter(Boolean).join(' · ');
          });
        }
      }
    } else {
      send = state.sendStats;
    }
    const lines = [];
    if (send) {
      lines.push(`<b>${I18n.t('Sending')}</b> ${send.size} · ${send.sent} fps${send.capture != null ? ` (${I18n.t('captured {0}', send.capture)})` : ''} · ${send.codec}${send.gpu ? ` ${I18n.t('on the graphics card')}` : ` ${I18n.t('on the processor')}`}`);
      // WebRTC only measures the upload as high as what it sends, so the number means
      // something only when the line is what holds the stream back.
      if (send.upload != null && send.diagnosis === 'bandwidth') lines.push(`<b>${I18n.t('Upload')}</b> ${I18n.t('about {0} Mbps', send.upload)}`);
      if (send.engine) lines.push(`<b>${I18n.t('Native engine')}</b> ${send.engine}`);
      if (send.auto) lines.push(`<b>${I18n.t('Auto quality')}</b> ${send.level}`);
      lines.push(`<span class="si-${send.diagnosis}">${I18n.t(DIAGNOSIS[send.diagnosis] || '')}</span>`);
    } else {
      lines.push(I18n.t('Waiting for numbers from the sender…'));
    }
    if (recv) lines.push(`<b>${I18n.t('Receiving')}</b> ${recv}`);
    box.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
  }
}

// Numbers from someone streaming to you.
function onStreamStats(peer, msg) {
  const entry = peer.remote.get(String(msg.id));
  if (!entry || !msg.stats || typeof msg.stats !== 'object') return;
  const s = msg.stats;
  // Only plain numbers and known words: it's shown in the page.
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  entry.senderStats = {
    size: /^\d{2,5}×\d{2,5}$/.test(s.size) ? s.size : '?',
    capture: num(s.capture), sent: num(s.sent) || 0, want: num(s.want),
    upload: s.upload != null && Number.isFinite(Number(s.upload)) ? Math.round(Number(s.upload) * 10) / 10 : null,
    codec: ['H264', 'AV1', 'VP9', 'VP8'].includes(s.codec) ? s.codec : '',
    gpu: s.gpu === true, auto: s.auto === true,
    level: /^\d{3,4}p \d{2} fps$/.test(s.level) ? s.level : '',
    diagnosis: DIAGNOSIS[s.diagnosis] ? s.diagnosis : 'ok',
    engine: typeof s.engine === 'string' ? s.engine.replace(/[<>&"]/g, '').slice(0, 120) : '',
  };
}

Specs.scan();
