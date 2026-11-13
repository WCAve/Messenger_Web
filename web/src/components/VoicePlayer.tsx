/**
 * The player for voice messages and audio files, in WhatsApp's style: the sender's picture (with a
 * microphone, or a note for an audio file), a play button, the recording's waveform that fills in as it
 * plays (click or drag to jump, arrow keys too), the time, and a speed button (1× / 1.5× / 2×) in place
 * of the picture while it plays. The waveform is worked out from the sound itself, once per file (two
 * at a time); until then (or if the browser can't read the file) it's a calm placeholder.
 * Only one plays at a time.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { attachmentUrl } from '../api';
import { useStore } from '../store';
import type { Attachment, Message } from '../types';
import { Avatar } from './ui';

const BARS = 42;
const SPEEDS = [1, 1.5, 2];

// Waveforms worked out so far (per file), and at most two being worked out at a time.
const waves = new Map<string, number[]>();
let working = 0;
const waiting: (() => void)[] = [];
let audioCtx: AudioContext | null = null;

async function waveFor(id: string, url: string): Promise<number[] | null> {
  const known = waves.get(id);
  if (known) return known;
  if (working >= 2) await new Promise<void>((r) => waiting.push(r));
  working++;
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return null;
    audioCtx ??= new AudioContext();
    const buf = await audioCtx.decodeAudioData(await res.arrayBuffer());
    const data = buf.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / BARS));
    const peaks: number[] = [];
    for (let i = 0; i < BARS; i++) {
      let sum = 0;
      const end = Math.min(data.length, (i + 1) * step);
      for (let j = i * step; j < end; j++) sum += data[j] * data[j];
      peaks.push(Math.sqrt(sum / Math.max(1, end - i * step)));
    }
    const max = Math.max(...peaks, 1e-4);
    const wave = peaks.map((p) => Math.max(0.12, Math.min(1, p / max)));
    waves.set(id, wave);
    return wave;
  } catch {
    return null; // a format this browser can't read: the placeholder stays
  } finally {
    working--;
    waiting.shift()?.();
  }
}

/** Until the real one is known: gentle bars, the same for the same file. */
function placeholder(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return Array.from({ length: BARS }, (_, i) => {
    h = (h * 1103515245 + 12345) >>> 0;
    return 0.25 + 0.3 * Math.abs(Math.sin(i / 3)) + ((h >>> 16) % 100) / 500;
  });
}

let playingNow: HTMLAudioElement | null = null;

function clock(s: number) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function VoicePlayer({ a, m }: { a: Attachment; m: Message }) {
  const url = attachmentUrl(a.id);
  const audio = useRef<HTMLAudioElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [wave, setWave] = useState<number[]>(() => waves.get(a.id) ?? placeholder(a.id));
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const waMe = useStore((s) => s.whatsapp.me);
  const network = useStore((s) => s.conversations[m.conversationId]?.network);

  // Work out the waveform when the message is shown. The file may not be here yet (still coming from
  // Signal or WhatsApp): then try again a few times, and once more when it's played.
  const tries = useRef(0);
  const loadWave = () => {
    if (waves.has(a.id)) return setWave(waves.get(a.id)!);
    void waveFor(a.id, url).then((w) => {
      if (w) setWave(w);
      else if (++tries.current < 4) setTimeout(loadWave, 3000 * tries.current);
    });
  };
  useEffect(() => {
    if (!waves.has(a.id)) loadWave(); // two at a time (waveFor), so a chat full of voice messages is fine
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.id, url]);

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed;
  }, [speed]);

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) {
      if (playingNow && playingNow !== el) playingNow.pause();
      playingNow = el;
      el.playbackRate = speed;
      void el.play().catch(() => {});
    } else el.pause();
  };

  const total = duration || 0;
  const progress = total ? Math.min(1, time / total) : 0;
  const seekTo = (fraction: number) => {
    const el = audio.current;
    if (!el || !total) return;
    el.currentTime = Math.max(0, Math.min(1, fraction)) * total;
    setTime(el.currentTime);
    setStarted(true);
  };
  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    seekTo((e.clientX - r.left) / r.width);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation(); // not the photo viewer's or chat's arrow keys
    if (total) seekTo((time + (e.key === 'ArrowRight' ? 5 : -5)) / total);
  };

  const self = m.author === 'self';
  const picture = self
    ? network === 'whatsapp' && waMe
      ? `/api/avatars/wa/${encodeURIComponent(waMe)}.jpg`
      : '/api/avatars/self.jpg'
    : m.author.startsWith('wa:')
      ? `/api/avatars/wa/${encodeURIComponent(m.author.slice(3))}.jpg`
      : `/api/avatars/contact/${encodeURIComponent(m.author)}.jpg`;
  const label = a.voiceNote ? 'Voice message' : a.filename || 'Audio';

  return (
    <div className={`voice${playing ? ' playing' : ''}`} ref={box} title={a.voiceNote ? undefined : a.filename ?? undefined}>
      <audio
        ref={audio}
        src={url}
        preload="metadata"
        onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
        onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onPlay={() => {
          setPlaying(true);
          setStarted(true);
          if (!waves.has(a.id)) loadWave();
        }}
        onPause={() => setPlaying(false)}
        onEnded={(e) => {
          setPlaying(false);
          setStarted(false);
          e.currentTarget.currentTime = 0;
          setTime(0);
        }}
      />
      {started ? (
        <button className="voice-speed" onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])} aria-label={`Speed ${speed}×`} title="Play faster">
          {speed}×
        </button>
      ) : (
        <span className="voice-face">
          <Avatar name={self ? 'You' : m.authorName} seed={m.author} src={picture} size={44} />
          <span className={`voice-badge${a.voiceNote ? '' : ' audio-file'}`} aria-hidden="true">
            {a.voiceNote ? (
              <svg viewBox="0 0 24 24" width="12" height="12">
                <path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1a7 7 0 0 0 6-6.9z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="12" height="12">
                <path fill="currentColor" d="M12 3v10.6A4 4 0 1 0 14 17V7h4V3z" />
              </svg>
            )}
          </span>
        </span>
      )}
      <button className="voice-play" onClick={toggle} aria-label={playing ? `Pause ${label}` : `Play ${label}`}>
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
          {playing ? <path fill="currentColor" d="M7 5h4v14H7zm6 0h4v14h-4z" /> : <path fill="currentColor" d="M8 5.5v13l11-6.5z" />}
        </svg>
      </button>
      <div className="voice-main">
        <div
          className="voice-wave"
          role="slider"
          tabIndex={0}
          aria-label={`${label}: position`}
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(time)}
          aria-valuetext={`${clock(time)} of ${clock(total)}`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            fromPointer(e);
          }}
          onPointerMove={(e) => e.buttons === 1 && fromPointer(e)}
          onKeyDown={onKey}
        >
          {wave.map((h, i) => (
            <span key={i} className={(i + 0.5) / wave.length <= progress ? 'on' : undefined} style={{ height: `${Math.round(h * 100)}%` }} />
          ))}
          <span className="voice-knob" style={{ left: `${progress * 100}%` }} />
        </div>
        <small className="voice-time">{clock(started ? time : total)}</small>
      </div>
    </div>
  );
}
