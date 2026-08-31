/**
 * One-shot capability probe.
 *
 * This is how the community answers the research doc's must-verify-on-hardware
 * list (H02, H17, H18): the CAM webview's Chromium version, its codec matrix
 * and its API surface are all unknown to us and cannot be assumed.
 */

const CODEC_PROBES: readonly { id: string; type: string }[] = [
  { id: 'h264', type: 'video/mp4; codecs="avc1.640028"' },
  { id: 'hevc', type: 'video/mp4; codecs="hev1.1.6.L93.B0"' },
  { id: 'av1', type: 'video/mp4; codecs="av01.0.05M.08"' },
  { id: 'vp9', type: 'video/webm; codecs="vp09.00.10.08"' },
  { id: 'vp8', type: 'video/webm; codecs="vp8, vorbis"' },
  { id: 'aac', type: 'audio/mp4; codecs="mp4a.40.2"' },
  { id: 'opus', type: 'audio/webm; codecs="opus"' },
  { id: 'flac', type: 'audio/flac' },
];

export interface CodecSupport {
  /** `HTMLMediaElement.canPlayType` — `''` | `'maybe'` | `'probably'`. */
  element: string;
  /** `MediaSource.isTypeSupported` — required for hls.js / dash.js. */
  mse: boolean;
}

export interface Capabilities {
  userAgent: string;
  chromiumVersion: string | null;
  electronVersion: string | null;
  dpr: number;
  screen: { width: number; height: number; innerWidth: number; innerHeight: number };
  hardwareConcurrency: number | null;
  deviceMemoryGb: number | null;
  codecs: Record<string, CodecSupport>;
  features: Record<string, boolean>;
}

/** `Chrome/108.0.0.0` → `'108.0.0.0'`. Null when the UA is not Chromium. */
export function parseChromiumVersion(ua: string): string | null {
  return /Chrom(?:e|ium)\/([\d.]+)/.exec(ua)?.[1] ?? null;
}

/** CAM is an Electron app; the Configuration Browser UA usually says so. */
export function parseElectronVersion(ua: string): string | null {
  return /Electron\/([\d.]+)/.exec(ua)?.[1] ?? null;
}

function probeCodecs(): Record<string, CodecSupport> {
  const video = document.createElement('video');
  const out: Record<string, CodecSupport> = {};
  const hasMse = 'MediaSource' in window;
  for (const { id, type } of CODEC_PROBES) {
    let element = '';
    try {
      element = video.canPlayType(type);
    } catch {
      element = '';
    }
    let supported = false;
    try {
      supported = hasMse && MediaSource.isTypeSupported(type);
    } catch {
      supported = false;
    }
    out[id] = { element, mse: supported };
  }
  return out;
}

interface NavigatorWithMemory extends Navigator {
  deviceMemory?: number;
}

export function probeCapabilities(): Capabilities {
  const ua = navigator.userAgent;
  const nav = navigator as NavigatorWithMemory;
  return {
    userAgent: ua,
    chromiumVersion: parseChromiumVersion(ua),
    electronVersion: parseElectronVersion(ua),
    dpr: window.devicePixelRatio,
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    },
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemoryGb: nav.deviceMemory ?? null,
    codecs: probeCodecs(),
    features: {
      webgl: (() => {
        try {
          return document.createElement('canvas').getContext('webgl') !== null;
        } catch {
          return false;
        }
      })(),
      webgl2: (() => {
        try {
          return document.createElement('canvas').getContext('webgl2') !== null;
        } catch {
          return false;
        }
      })(),
      webgpu: 'gpu' in navigator,
      webCodecs: 'VideoDecoder' in window,
      offscreenCanvas: 'OffscreenCanvas' in window,
      mediaSource: 'MediaSource' in window,
      eventSource: 'EventSource' in window,
      broadcastChannel: 'BroadcastChannel' in window,
      cryptoSubtle: 'crypto' in window && 'subtle' in window.crypto,
      storageManager: 'storage' in navigator,
      indexedDb: 'indexedDB' in window,
      audioContext: 'AudioContext' in window,
    },
  };
}
