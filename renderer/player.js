// Thin video player wrapper. Picks the best playable stream from a Piped /
// yt-dlp response and hands it to the <video> element via hls.js or dash.js.

export function play(videoEl, streams) {
  // 1. Native HLS (Safari/macOS) or hls.js fallback — preferred when present.
  if (streams.hls) {
    if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      videoEl.src = streams.hls;
      return;
    }
    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls({ enableWorker: true, lowLatencyMode: false });
      hls.loadSource(streams.hls);
      hls.attachMedia(videoEl);
      videoEl._hls = hls;
      return;
    }
  }

  // 2. DASH manifest via dash.js — what unlocks adaptive HD on YouTube VOD.
  if (streams.dash && window.dashjs?.MediaPlayer) {
    const dash = window.dashjs.MediaPlayer().create();
    dash.initialize(videoEl, streams.dash, /* autoplay */ true);
    videoEl._dash = dash;
    return;
  }

  // 3. Video-only + audio-only sync. YouTube's muxed progressive streams cap
  //    at 360p; higher resolutions are video-only fragments and need a paired
  //    audio-only stream. We attach a sidecar <audio> and keep them in sync.
  const videoOnlyList = (streams.videoStreams || [])
    .filter(s => s.videoOnly && s.url)
    .sort((a, b) => parseInt(b.quality) - parseInt(a.quality));
  if (streams.audioStream && videoOnlyList.length) {
    attachAudioSync(videoEl, videoOnlyList[0].url, streams.audioStream.url);
    return;
  }

  // 4. Muxed progressive (caps at 360p on YouTube nowadays).
  const combined = (streams.videoStreams || []).filter(s => !s.videoOnly && s.url);
  combined.sort((a, b) => parseInt(b.quality) - parseInt(a.quality));
  if (combined.length) {
    videoEl.src = combined[0].url;
    return;
  }

  // 5. Last resort — highest video-only stream (no audio).
  if (videoOnlyList.length) videoEl.src = videoOnlyList[0].url;
}

// Attaches a hidden <audio> sidecar element and keeps it in sync with the
// main <video>. Used when YouTube only offers separate video-only/audio-only
// streams. Exported so the resolution picker can switch between video-only
// and muxed at runtime.
export function attachAudioSync(videoEl, videoUrl, audioUrl) {
  if (videoEl._audio) detachAudioSync(videoEl);

  const wasPlaying = !videoEl.paused && !videoEl.ended;
  const wasTime = videoEl.currentTime || 0;

  videoEl.src = videoUrl;
  videoEl.muted = true; // audio comes from the sidecar element

  const audioEl = new Audio();
  audioEl.preload = 'auto';
  audioEl.src = audioUrl;

  const onPlay  = () => { if (audioEl.paused) audioEl.play().catch(() => {}); };
  const onPause = () => { if (!audioEl.paused) audioEl.pause(); };
  const onSeek  = () => { audioEl.currentTime = videoEl.currentTime; };
  const onRate  = () => { audioEl.playbackRate = videoEl.playbackRate; };
  const onVol   = () => { audioEl.volume = videoEl.volume; audioEl.muted = false; };
  const onWait  = () => { if (!audioEl.paused) audioEl.pause(); };
  const onPlaying = () => { if (videoEl.paused) return; audioEl.currentTime = videoEl.currentTime; audioEl.play().catch(() => {}); };

  videoEl.addEventListener('play',  onPlay);
  videoEl.addEventListener('pause', onPause);
  videoEl.addEventListener('seeking', onSeek);
  videoEl.addEventListener('seeked', onSeek);
  videoEl.addEventListener('ratechange', onRate);
  videoEl.addEventListener('volumechange', onVol);
  videoEl.addEventListener('waiting', onWait);
  videoEl.addEventListener('playing', onPlaying);

  audioEl.volume = videoEl.volume;
  audioEl.playbackRate = videoEl.playbackRate;

  // Drift correction — re-aligns more than ±0.25s every 500ms.
  const driftInterval = setInterval(() => {
    if (!videoEl._audio) return;
    if (videoEl.paused !== audioEl.paused) {
      if (videoEl.paused) audioEl.pause();
      else audioEl.play().catch(() => {});
    }
    const drift = Math.abs(audioEl.currentTime - videoEl.currentTime);
    if (drift > 0.25) {
      audioEl.currentTime = videoEl.currentTime;
    }
  }, 500);

  videoEl._audio = audioEl;
  videoEl._audioCleanup = () => {
    clearInterval(driftInterval);
    videoEl.removeEventListener('play',  onPlay);
    videoEl.removeEventListener('pause', onPause);
    videoEl.removeEventListener('seeking', onSeek);
    videoEl.removeEventListener('seeked', onSeek);
    videoEl.removeEventListener('ratechange', onRate);
    videoEl.removeEventListener('volumechange', onVol);
    videoEl.removeEventListener('waiting', onWait);
    videoEl.removeEventListener('playing', onPlaying);
    videoEl.muted = false;
    try { audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load(); } catch {}
  };

  // Restore prior play state when switching qualities mid-playback.
  if (wasTime > 0) {
    videoEl.currentTime = wasTime;
  }
  if (wasPlaying) {
    videoEl.play().catch(() => {});
  }
}

export function detachAudioSync(videoEl) {
  if (videoEl && videoEl._audioCleanup) {
    videoEl._audioCleanup();
    videoEl._audio = null;
    videoEl._audioCleanup = null;
  }
}

export function destroy(videoEl) {
  if (videoEl && videoEl._hls) {
    videoEl._hls.destroy();
    videoEl._hls = null;
  }
  if (videoEl && videoEl._dash) {
    try { videoEl._dash.reset(); } catch {}
    videoEl._dash = null;
  }
  if (videoEl && videoEl._audio) {
    detachAudioSync(videoEl);
  }
  if (videoEl) {
    videoEl.removeAttribute('src');
    videoEl.load();
  }
}
