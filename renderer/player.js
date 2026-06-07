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
      const hls = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        // Don't fetch a higher resolution than the player is actually showing
        // (no 4K decoded into a 700px panel) — big bandwidth saver, faster
        // starts, and fewer stalls because each second of video is smaller.
        capLevelToPlayerSize: true,
        // Cap the retained back-buffer (hls.js keeps the entire watched portion
        // by default) so memory/data held doesn't grow unbounded on long videos.
        backBufferLength: 30,
      });
      hls.loadSource(streams.hls);
      hls.attachMedia(videoEl);
      videoEl._hls = hls;
      return;
    }
  }

  // 2. DASH manifest via dash.js — what unlocks adaptive HD on YouTube VOD.
  if (streams.dash && window.dashjs?.MediaPlayer) {
    const dash = window.dashjs.MediaPlayer().create();
    try {
      dash.updateSettings({
        streaming: {
          abr: {
            // Cap quality to the on-screen player size (accounting for DPR)
            // instead of pulling the highest manifest rendition into a small
            // panel — less data, faster start, fewer rebuffers.
            limitBitrateByPortal: true,
            usePixelRatioInLimitBitrateByPortal: true,
          },
          // Jump up a rendition promptly once bandwidth allows (snappier than
          // waiting for the current buffer to drain first).
          buffer: { fastSwitchEnabled: true },
        },
      });
    } catch {}
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

// Sidecar <audio> sync for the YouTube video-only + audio-only stream pair.
//
// Major rewrite to address the user-visible "audio cuts out instead of buffering"
// bug. The previous implementation pause-d the sidecar audio whenever the video
// fired `waiting`/`stalled`, AND aggressively reseek-ed audio whenever drift
// exceeded 0.25 s. The combined effect: any brief network hiccup produced
// instant silence, and the rapid drift-snap pulses sounded like crackling.
//
// New approach:
//   - No `waiting` listener at all. Audio plays through transient video stalls
//     so the user keeps hearing the soundtrack continuously while the picture
//     stutters — far less startling than going silent.
//   - Drift correction is gentler: 500 ms interval (was 250 ms), 0.5 s hard-snap
//     threshold (was 0.25 s). Small drifts (0.08–0.5 s) are nudged via a ±3 %
//     playbackRate adjustment that converges in 1–2 s without an audible jump.
//   - "Video frozen" detection (network stall while !paused) is preserved
//     because it prevents the old "looping last second of audio" bug — but it
//     no longer reseek-s audio; it just caps how far audio is allowed to lead.
//   - Seeks only pause audio for big jumps (>2 s). Fine-tuning the playhead by
//     a fraction of a second no longer dumps the sound.
export function attachAudioSync(videoEl, videoUrl, audioUrl) {
  if (videoEl._audio) detachAudioSync(videoEl);

  const wasPlaying = !videoEl.paused && !videoEl.ended;
  const wasTime = videoEl.currentTime || 0;

  videoEl.src = videoUrl;
  videoEl.muted = true; // sound comes from the sidecar element

  const audioEl = new Audio();
  audioEl.preload = 'auto';
  audioEl.src = audioUrl;

  const onPlay  = () => { if (audioEl.paused) audioEl.play().catch(() => {}); };
  const onPause = () => { if (!audioEl.paused) audioEl.pause(); };
  // Only pause audio for genuinely big seeks. Small fine-tunes (e.g. arrow-key
  // 5 s skip) keep audio rolling and just re-snap currentTime.
  const onSeeking = () => {
    const jump = Math.abs(audioEl.currentTime - videoEl.currentTime);
    if (jump > 2.0 && !audioEl.paused) audioEl.pause();
    audioEl.currentTime = videoEl.currentTime;
  };
  const onSeeked = () => {
    audioEl.currentTime = videoEl.currentTime;
    audioEl.playbackRate = videoEl.playbackRate;
    if (!videoEl.paused && audioEl.paused) audioEl.play().catch(() => {});
  };
  const onRate = () => { audioEl.playbackRate = videoEl.playbackRate; };
  const onVol  = () => { audioEl.volume = videoEl.volume; audioEl.muted = false; };
  // INTENTIONALLY no `waiting` listener — see header comment. The drift loop
  // below handles stalls without nuking the audio track.
  const onPlaying = () => {
    if (videoEl.paused) return;
    if (audioEl.paused) audioEl.play().catch(() => {});
  };

  videoEl.addEventListener('play',  onPlay);
  videoEl.addEventListener('pause', onPause);
  videoEl.addEventListener('seeking', onSeeking);
  videoEl.addEventListener('seeked', onSeeked);
  videoEl.addEventListener('ratechange', onRate);
  videoEl.addEventListener('volumechange', onVol);
  videoEl.addEventListener('playing', onPlaying);

  audioEl.volume = videoEl.volume;
  audioEl.playbackRate = videoEl.playbackRate;

  // Drift correction + stall handling. Half the previous tick rate and twice
  // the snap threshold — the dial moves toward "tolerate small drift" instead
  // of "correct every micro-drift loudly".
  let lastVideoTime = videoEl.currentTime;
  let videoFrozen = false;

  const driftInterval = setInterval(() => {
    if (!videoEl._audio) return;
    if (videoEl.seeking) return;

    const videoAdvancing = Math.abs(videoEl.currentTime - lastVideoTime) > 0.01;
    lastVideoTime = videoEl.currentTime;

    // Network stall: video element isn't paused but currentTime stopped moving.
    // Don't yank audio back — that was the old looping bug. Instead let audio
    // keep going briefly (user hears continuous sound), and only pause it if
    // it overshoots the frozen video by more than 2 s.
    if (!videoEl.paused && !videoEl.ended && !videoAdvancing) {
      videoFrozen = true;
      const lead = audioEl.currentTime - videoEl.currentTime;
      if (lead > 2 && !audioEl.paused) audioEl.pause();
      return;
    }
    if (videoFrozen && videoAdvancing) {
      // Video just recovered. Snap audio to it once and restore normal rate
      // instead of chasing it tick-by-tick.
      videoFrozen = false;
      audioEl.currentTime = videoEl.currentTime;
      audioEl.playbackRate = videoEl.playbackRate;
      if (!videoEl.paused && audioEl.paused) audioEl.play().catch(() => {});
      return;
    }

    // Mirror paused state if it got out of sync some other way.
    if (videoEl.paused !== audioEl.paused) {
      if (videoEl.paused) audioEl.pause();
      else audioEl.play().catch(() => {});
    }
    if (videoEl.paused) return;

    const drift = audioEl.currentTime - videoEl.currentTime;
    const absDrift = Math.abs(drift);
    const baseRate = videoEl.playbackRate;

    if (absDrift > 0.5) {
      // Big drift → one hard snap, then return to base rate.
      audioEl.currentTime = videoEl.currentTime;
      audioEl.playbackRate = baseRate;
    } else if (absDrift > 0.08) {
      // Small drift → ±3 % rate nudge. Sub-audible pitch change, converges
      // toward sync over 1–2 s without any time jump.
      audioEl.playbackRate = drift > 0 ? baseRate * 0.97 : baseRate * 1.03;
    } else if (audioEl.playbackRate !== baseRate) {
      // In sync → ensure we're not still nudging from a previous correction.
      audioEl.playbackRate = baseRate;
    }
  }, 500);

  videoEl._audio = audioEl;
  videoEl._audioCleanup = () => {
    clearInterval(driftInterval);
    videoEl.removeEventListener('play',  onPlay);
    videoEl.removeEventListener('pause', onPause);
    videoEl.removeEventListener('seeking', onSeeking);
    videoEl.removeEventListener('seeked', onSeeked);
    videoEl.removeEventListener('ratechange', onRate);
    videoEl.removeEventListener('volumechange', onVol);
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
