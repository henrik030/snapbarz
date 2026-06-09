"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import Image from "next/image";
import * as MP4Box from "mp4box";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";

// Suppress mp4box's console.error for padding bytes at end of file.
// "Invalid box type: ''" is a benign warning about null-byte padding, not a real error.
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const log = (MP4Box as any).Log;
  if (log?.error) {
    const orig = log.error.bind(log);
    log.error = (module: string, msg: string, ...rest: unknown[]) => {
      if (module === "BoxParser" && typeof msg === "string" && msg.startsWith("Invalid box type:")) return;
      orig(module, msg, ...rest);
    };
  }
}

interface TextSettings {
  text: string;
  fontSize: number;
  positionY: number;
  barOpacity: number;
  barPadding: number;
  bold: boolean;
  italic: boolean;
}

const DEFAULT_SETTINGS: TextSettings = {
  text: "Your text here",
  fontSize: 42,
  positionY: 50,
  barOpacity: 0.6,
  barPadding: 24,
  bold: false,
  italic: false,
};

function Timeline({
  currentTime,
  duration,
  onSeek,
}: {
  currentTime: number;
  duration: number;
  onSeek: (t: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  const seek = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      const track = trackRef.current;
      if (!track || !duration) return;
      const { left, width } = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - left) / width));
      onSeek(ratio * duration);
    },
    [duration, onSeek]
  );

  const handleMouseDown = (e: React.MouseEvent) => {
    seek(e);
    const onMove = (ev: MouseEvent) => seek(ev);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const progress = duration ? currentTime / duration : 0;

  return (
    <div
      ref={trackRef}
      onMouseDown={handleMouseDown}
      className="relative flex-1 h-8 flex items-center cursor-pointer group"
    >
      <div className="w-full h-1 bg-zinc-700 rounded-full overflow-visible relative">
        <div className="h-full bg-white rounded-full" style={{ width: `${progress * 100}%` }} />
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 bg-white rounded-full shadow transition-transform group-hover:scale-125"
          style={{ left: `${progress * 100}%` }}
        />
      </div>
    </div>
  );
}

function CircleProgress({ progress }: { progress: number }) {
  const r = 40;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - progress / 100);
  return (
    <div className="relative w-28 h-28 flex items-center justify-center">
      <svg className="absolute inset-0 -rotate-90" width="112" height="112" viewBox="0 0 112 112">
        <circle cx="56" cy="56" r={r} fill="none" stroke="#3f3f46" strokeWidth="8" />
        <circle
          cx="56" cy="56" r={r} fill="none"
          stroke="#eab308" strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.3s ease" }}
        />
      </svg>
      <span className="text-xl font-semibold tabular-nums">{progress}%</span>
    </div>
  );
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

function drawOverlayOnFrame(
  frame: VideoFrame,
  canvas: OffscreenCanvas,
  ctx: OffscreenCanvasRenderingContext2D,
  settings: TextSettings,
  rotation: 0 | 90 | 180 | 270 = 0,
) {
  const { text, fontSize, positionY, barOpacity, barPadding, bold, italic } = settings;

  // Apply rotation transform before drawing the raw frame.
  // canvas is already sized to the display dimensions (post-rotation).
  ctx.save();
  if (rotation === 90) {
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
  } else if (rotation === 180) {
    ctx.translate(canvas.width, canvas.height);
    ctx.rotate(Math.PI);
  } else if (rotation === 270) {
    ctx.translate(0, canvas.height);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(frame, 0, 0, frame.codedWidth, frame.codedHeight);
  ctx.restore();

  if (!text.trim()) return;

  const weight = bold ? "bold" : "normal";
  const style = italic ? "italic" : "normal";
  ctx.font = `${style} ${weight} ${fontSize}px Inter, -apple-system, sans-serif`;

  const maxWidth = canvas.width - barPadding * 2;
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ");
    let current = "";
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    lines.push(current);
  }

  const lineHeight = fontSize * 1.3;
  const actualTextHeight = (lines.length - 1) * lineHeight + fontSize;
  const barHeight = actualTextHeight + barPadding * 2;
  const barY = Math.max(
    0,
    Math.min(canvas.height - barHeight, (positionY / 100) * canvas.height - barHeight / 2)
  );

  ctx.fillStyle = `rgba(0, 0, 0, ${barOpacity})`;
  ctx.fillRect(0, barY, canvas.width, barHeight);

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  lines.forEach((line, i) => {
    ctx.fillText(line, canvas.width / 2, barY + barPadding + i * lineHeight, maxWidth);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MP4BoxFile = any;

// Derive rotation angle (0 | 90 | 180 | 270) from a tkhd matrix (9 int32 values, 16.16 fixed-point).
function getRotationDeg(matrix: number[]): 0 | 90 | 180 | 270 {
  const a = matrix[0] / 65536;
  const b = matrix[1] / 65536;
  const deg = Math.round(Math.atan2(b, a) * 180 / Math.PI);
  const norm = ((deg % 360) + 360) % 360;
  if (norm === 90 || norm === 180 || norm === 270) return norm;
  return 0;
}

interface DemuxResult {
  videoChunks: EncodedVideoChunk[];
  videoConfig: VideoDecoderConfig;
  audioChunks: EncodedAudioChunk[];
  audioConfig: AudioDecoderConfig | null;
  durationUs: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

function demuxFile(file: File): Promise<DemuxResult> {
  return new Promise((resolve, reject) => {
    const mp4 = MP4Box.createFile() as MP4BoxFile;

    const videoChunks: EncodedVideoChunk[] = [];
    const audioChunks: EncodedAudioChunk[] = [];
    let videoConfig: VideoDecoderConfig | null = null;
    let audioConfig: AudioDecoderConfig | null = null;
    let videoTrackId = -1;
    let audioTrackId = -1;
    let durationUs = 0;
    let width = 0;
    let height = 0;
    let rotation: 0 | 90 | 180 | 270 = 0;

    mp4.onError = reject;

    mp4.onReady = (info: MP4BoxFile) => {
      durationUs = Math.round(info.duration / info.timescale * 1_000_000);

      const videoTrack = info.videoTracks?.[0];
      const audioTrack = info.audioTracks?.[0];

      if (!videoTrack) { reject(new Error("No video track found")); return; }

      videoTrackId = videoTrack.id;
      width = videoTrack.video.width;
      height = videoTrack.video.height;
      const tkhd = mp4.getTrackById(videoTrack.id)?.tkhd;
      if (tkhd?.matrix) rotation = getRotationDeg(tkhd.matrix);

      const codec = videoTrack.codec.startsWith("avc") ? videoTrack.codec
        : videoTrack.codec.startsWith("hev") ? videoTrack.codec
        : videoTrack.codec;

      videoConfig = {
        codec,
        codedWidth: width,
        codedHeight: height,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        description: getVideoDescription(mp4, videoTrack as any),
      };

      mp4.setExtractionOptions(videoTrackId, null, { nbSamples: 100 });

      if (audioTrack) {
        audioTrackId = audioTrack.id;
        audioConfig = {
          codec: audioTrack.codec,
          sampleRate: audioTrack.audio.sample_rate,
          numberOfChannels: audioTrack.audio.channel_count,
        };
        mp4.setExtractionOptions(audioTrackId, null, { nbSamples: 100 });
      }

      mp4.start();
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mp4.onSamples = (_trackId: number, _user: unknown, samples: any[]) => {
      for (const sample of samples) {
        const isVideo = sample.track_id === videoTrackId;
        const isAudio = sample.track_id === audioTrackId;
        const ts = Math.round(sample.cts * 1_000_000 / sample.timescale);
        const dur = Math.round(sample.duration * 1_000_000 / sample.timescale);

        if (isVideo) {
          videoChunks.push(new EncodedVideoChunk({
            type: sample.is_sync ? "key" : "delta",
            timestamp: ts,
            duration: dur,
            data: sample.data,
          }));
        } else if (isAudio) {
          audioChunks.push(new EncodedAudioChunk({
            type: "key",
            timestamp: ts,
            duration: dur,
            data: sample.data,
          }));
        }
      }
    };

    file.arrayBuffer().then((buf) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (buf as any).fileStart = 0;
      mp4.appendBuffer(buf);
      mp4.flush();

      // Give onSamples a tick to fire after flush
      setTimeout(() => {
        if (!videoConfig) { reject(new Error("Could not read video config")); return; }
        resolve({ videoChunks, videoConfig, audioChunks, audioConfig, durationUs, width, height, rotation });
      }, 100);
    }).catch(reject);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getVideoDescription(mp4: MP4BoxFile, track: any): Uint8Array | undefined {
  const trak = mp4.getTrackById(track.id);
  if (!trak) return undefined;
  for (const entry of trak.mdia?.minf?.stbl?.stsd?.entries ?? []) {
    const box = entry.avcC ?? entry.hvcC ?? entry.av1C;
    if (box) {
      // BIG_ENDIAN = 1 in mp4box v2 (LITTLE_ENDIAN = 2)
      const stream = new MP4Box.DataStream(undefined, 0, 1 /* BIG_ENDIAN */);
      box.write(stream);
      // box.size is set by write() to the exact byte count (header included).
      // Slice off the 8-byte box header to get the raw decoder config record.
      return new Uint8Array(stream.buffer as ArrayBuffer, 8, box.size - 8);
    }
  }
  return undefined;
}

export default function VideoEditor() {
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [settings, setSettings] = useState<TextSettings>(DEFAULT_SETTINGS);
  const [isExporting, setIsExporting] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState("");
  const [exportProgress, setExportProgress] = useState(0);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportDone, setExportDone] = useState(false);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [exportFilename, setExportFilename] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showBrowserHint, setShowBrowserHint] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const settingsRef = useRef(settings);
  const abortRef = useRef(false);

  useEffect(() => { settingsRef.current = settings; }, [settings]);

  useEffect(() => {
    const isChromium = !!(window as unknown as Record<string, unknown>).chrome;
    if (!isChromium) setShowBrowserHint(true);
  }, []);

  // Load Inter variable font for canvas rendering
  useEffect(() => {
    const regular = new FontFace("Inter", "url(/font/Inter-VariableFont_opsz,wght.ttf)", {
      weight: "100 900",
      style: "normal",
    });
    const italic = new FontFace("Inter", "url(/font/Inter-Italic-VariableFont_opsz,wght.ttf)", {
      weight: "100 900",
      style: "italic",
    });
    Promise.all([regular.load(), italic.load()])
      .then(([r, i]) => { document.fonts.add(r); document.fonts.add(i); })
      .catch(console.error);
  }, []);

  const drawOverlay = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const s = settingsRef.current;

    canvas.width = video.videoWidth || 360;
    canvas.height = video.videoHeight || 640;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    if (!s.text.trim()) return;

    const padding = s.barPadding;
    const fontSize = s.fontSize;
    const weight = s.bold ? "bold" : "normal";
    const style = s.italic ? "italic" : "normal";
    ctx.font = `${style} ${weight} ${fontSize}px Inter, -apple-system, sans-serif`;

    const maxWidth = canvas.width - padding * 2;
    const lines: string[] = [];

    for (const paragraph of s.text.split("\n")) {
      const words = paragraph.split(" ");
      let current = "";
      for (const word of words) {
        const test = current ? `${current} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && current) {
          lines.push(current);
          current = word;
        } else {
          current = test;
        }
      }
      lines.push(current);
    }

    const lineHeight = fontSize * 1.3;
    const actualTextHeight = (lines.length - 1) * lineHeight + fontSize;
    const barHeight = actualTextHeight + padding * 2;

    const barY = Math.max(
      0,
      Math.min(canvas.height - barHeight, (s.positionY / 100) * canvas.height - barHeight / 2)
    );

    ctx.fillStyle = `rgba(0, 0, 0, ${s.barOpacity})`;
    ctx.fillRect(0, barY, canvas.width, barHeight);

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    lines.forEach((line, i) => {
      ctx.fillText(line, canvas.width / 2, barY + padding + i * lineHeight, maxWidth);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!videoSrc) return;
    const video = videoRef.current;
    if (!video) return;

    const loop = () => {
      drawOverlay();
      animFrameRef.current = requestAnimationFrame(loop);
    };

    const onLoaded = () => {
      video.currentTime = 0;
      animFrameRef.current = requestAnimationFrame(loop);
    };

    video.addEventListener("loadeddata", onLoaded);
    return () => {
      video.removeEventListener("loadeddata", onLoaded);
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [videoSrc, drawOverlay]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    setVideoFile(file);
    setIsPlaying(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.type.startsWith("video/")) return;
    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    setVideoFile(file);
    setIsPlaying(false);
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) { video.play(); setIsPlaying(true); }
    else { video.pause(); setIsPlaying(false); }
  };

  const handleExport = async () => {
    if (!videoFile) return;
    setIsExporting(true);
    setExportProgress(0);
    setExportDone(false);
    setExportUrl(null);
    setExportModalOpen(true);
    abortRef.current = false;

    // Pause playback — frames are being read for export
    if (videoRef.current) { videoRef.current.pause(); setIsPlaying(false); }

    try {
      setLoadingPhase("Reading video…");
      const { videoChunks, videoConfig, audioChunks, audioConfig, durationUs, width, height, rotation } =
        await demuxFile(videoFile);

      if (abortRef.current) return;

      // Display dimensions flip when rotation is 90° or 270°
      const displayW = (rotation === 90 || rotation === 270) ? height : width;
      const displayH = (rotation === 90 || rotation === 270) ? width : height;
      // H.264 requires even dimensions
      const encodeW = displayW % 2 === 0 ? displayW : displayW - 1;
      const encodeH = displayH % 2 === 0 ? displayH : displayH - 1;

      setLoadingPhase("Starting encoder…");
      console.log("[export] video config:", videoConfig, "frames:", videoChunks.length, "rotation:", rotation, "display:", encodeW, "x", encodeH);

      const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: "avc", width: encodeW, height: encodeH },
        audio: audioConfig
          ? { codec: "aac", sampleRate: audioConfig.sampleRate, numberOfChannels: audioConfig.numberOfChannels }
          : undefined,
        fastStart: "in-memory",
      });

      const offscreen = new OffscreenCanvas(encodeW, encodeH);
      const ctx = offscreen.getContext("2d") as OffscreenCanvasRenderingContext2D;

      const totalFrames = videoChunks.length;
      let encodedCount = 0;

      const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => { throw e; },
      });

      encoder.configure({
        codec: "avc1.4d0034",
        width: encodeW,
        height: encodeH,
        bitrate: 8_000_000,
        framerate: 30,
        hardwareAcceleration: "prefer-hardware",
      });

      const decoder = new VideoDecoder({
        output: (frame) => {
          if (abortRef.current) { frame.close(); return; }

          drawOverlayOnFrame(frame, offscreen, ctx, settingsRef.current, rotation);
          frame.close();

          const keyframe = encodedCount % 60 === 0;
          encoder.encode(new VideoFrame(offscreen, { timestamp: frame.timestamp }), { keyFrame: keyframe });

          encodedCount++;
          setExportProgress(Math.round((encodedCount / totalFrames) * 95));
        },
        error: (e) => { throw e; },
      });

      const support = await VideoDecoder.isConfigSupported(videoConfig);
      if (!support.supported) throw new Error(`Video codec not supported by this browser: ${videoConfig.codec}`);
      decoder.configure(videoConfig);

      // Feed chunks to decoder, throttle to avoid unbounded queue
      for (const chunk of videoChunks) {
        if (abortRef.current) break;
        decoder.decode(chunk);
        // Let encoder breathe if it falls too far behind
        if (decoder.decodeQueueSize > 20) {
          await new Promise(r => setTimeout(r, 0));
        }
      }

      await decoder.flush();
      await encoder.flush();

      // Mux audio chunks directly — no re-encode needed
      if (audioConfig) {
        for (const chunk of audioChunks) {
          muxer.addAudioChunk(chunk, { decoderConfig: audioConfig });
        }
      }

      muxer.finalize();

      const { buffer } = muxer.target as ArrayBufferTarget;
      const blob = new Blob([buffer], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      setExportProgress(100);
      setExportUrl(url);
      const baseName = videoFile.name.replace(/\.[^.]+$/, "");
      setExportFilename(`captioned_${baseName}.mp4`);
      setExportDone(true);
    } catch (err) {
      console.error("Export failed:", err);
      setExportModalOpen(false);
      alert(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsExporting(false);
      setLoadingPhase("");
    }
  };

  const handleDownload = () => {
    if (!exportUrl || !exportFilename) return;
    const a = document.createElement("a");
    a.href = exportUrl;
    a.download = exportFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleCreateAnother = () => {
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    setExportUrl(null);
    setExportModalOpen(false);
    setExportDone(false);
    setVideoSrc(null);
    setVideoFile(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    cancelAnimationFrame(animFrameRef.current);
  };

  return (
    <div className="flex flex-col h-screen">
      {showBrowserHint && (
        <div className="flex items-center justify-between gap-3 px-4 py-2 bg-amber-950 border-b border-amber-800 text-amber-300 text-xs">
          <span>This app uses WebCodecs and works best in Chrome or Arc. Export may not work in Safari or Firefox.</span>
          <button
            onClick={() => setShowBrowserHint(false)}
            className="flex-shrink-0 hover:text-amber-100 transition-colors cursor-pointer"
            aria-label="Dismiss"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    <div className="flex flex-col md:flex-row flex-1 min-h-0">
      {/* Left panel */}
      <div className="w-full md:w-80 flex-shrink-0 bg-zinc-900 border-r border-zinc-800 p-6 flex flex-col gap-6 overflow-y-auto">
        <Image src="/logo.png" alt="Logo" width={160} height={56} className="object-contain" />

        {/* Upload */}
        <div>
          <label className="block text-xs text-zinc-400 uppercase tracking-widest mb-2">Video</label>
          <div
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            className="border-2 border-dashed border-zinc-700 rounded-lg p-4 text-center cursor-pointer hover:border-zinc-500 transition-colors"
            onClick={() => document.getElementById("file-input")?.click()}
          >
            {videoFile ? (
              <p className="text-sm text-zinc-300 truncate">{videoFile.name}</p>
            ) : (
              <p className="text-sm text-zinc-500">Drop a video or click to upload</p>
            )}
          </div>
          <input id="file-input" type="file" accept="video/*" className="hidden" onChange={handleFileChange} />
        </div>

        {/* Text */}
        <div>
          <label className="block text-xs text-zinc-400 uppercase tracking-widest mb-2">Text</label>
          <textarea
            value={settings.text}
            onChange={(e) => setSettings((s) => ({ ...s, text: e.target.value }))}
            rows={3}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 resize-none focus:outline-none focus:border-zinc-500"
            placeholder="Enter caption text..."
          />
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => setSettings((s) => ({ ...s, bold: !s.bold }))}
              className={`w-9 h-9 rounded-lg text-sm font-bold transition-colors cursor-pointer ${
                settings.bold ? "bg-white text-black" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
              }`}
            >
              B
            </button>
            <button
              onClick={() => setSettings((s) => ({ ...s, italic: !s.italic }))}
              className={`w-9 h-9 rounded-lg text-sm italic transition-colors cursor-pointer ${
                settings.italic ? "bg-white text-black" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
              }`}
            >
              I
            </button>
          </div>
        </div>

        {/* Font size */}
        <div>
          <label className="block text-xs text-zinc-400 uppercase tracking-widest mb-2">
            Font size — {settings.fontSize}px
          </label>
          <input
            type="range" min={14} max={120} value={settings.fontSize}
            onChange={(e) => setSettings((s) => ({ ...s, fontSize: Number(e.target.value) }))}
            className="w-full accent-white cursor-pointer"
          />
        </div>

        {/* Position */}
        <div>
          <label className="block text-xs text-zinc-400 uppercase tracking-widest mb-2">
            Position — {settings.positionY === 0 ? "top" : settings.positionY === 100 ? "bottom" : `${settings.positionY}%`}
          </label>
          <input
            type="range" min={0} max={100} value={settings.positionY}
            onChange={(e) => setSettings((s) => ({ ...s, positionY: Number(e.target.value) }))}
            className="w-full accent-white cursor-pointer"
          />
        </div>

        {/* Bar opacity */}
        <div>
          <label className="block text-xs text-zinc-400 uppercase tracking-widest mb-2">
            Bar opacity — {Math.round(settings.barOpacity * 100)}%
          </label>
          <input
            type="range" min={0} max={100} value={Math.round(settings.barOpacity * 100)}
            onChange={(e) => setSettings((s) => ({ ...s, barOpacity: Number(e.target.value) / 100 }))}
            className="w-full accent-white cursor-pointer"
          />
        </div>

        {/* Padding */}
        <div>
          <label className="block text-xs text-zinc-400 uppercase tracking-widest mb-2">
            Bar padding — {settings.barPadding}px
          </label>
          <input
            type="range" min={4} max={60} value={settings.barPadding}
            onChange={(e) => setSettings((s) => ({ ...s, barPadding: Number(e.target.value) }))}
            className="w-full accent-white cursor-pointer"
          />
        </div>

        <div className="flex-1" />

        {/* Export */}
        <button
          onClick={handleExport}
          disabled={!videoFile || isExporting}
          className="w-full py-3 rounded-xl bg-yellow-400 text-black text-sm font-semibold hover:bg-yellow-300 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Export & Download
        </button>
      </div>

      {/* Right panel — preview */}
      <div className="flex-1 flex items-center justify-center bg-zinc-950 p-6 relative">
        <a
          href="mailto:dymkehenrik@gmail.com?subject=Snapbarz feedback"
          className="absolute top-4 right-4 text-xs text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
        >
          Give feedback
        </a>
        {!videoSrc ? (
          <div className="text-zinc-600 text-sm text-center">
            <p className="text-4xl mb-3">🎬</p>
            <p>Upload a video to see the preview</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 w-full max-w-sm">
            <video
              ref={videoRef}
              src={videoSrc}
              className="absolute opacity-0 pointer-events-none w-px h-px"
              loop
              playsInline
              onEnded={() => setIsPlaying(false)}
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
              onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            />
            <canvas
              ref={canvasRef}
              className="max-h-[72vh] max-w-full rounded-xl shadow-2xl"
              style={{ aspectRatio: "9/16" }}
            />
            {isExporting && (
              <p className="text-xs text-zinc-500 animate-pulse">Exporting… {exportProgress > 0 ? `${exportProgress}%` : ""}</p>
            )}
            <div className={`flex items-center gap-3 w-full px-1 transition-opacity ${isExporting ? "opacity-30 pointer-events-none select-none" : ""}`}>
              <button
                onClick={togglePlay}
                disabled={isExporting}
                className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full bg-white text-black cursor-pointer hover:bg-zinc-200 transition-colors disabled:cursor-not-allowed"
                aria-label={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 4l14 8-14 8V4z" />
                  </svg>
                )}
              </button>
              <span className="flex-shrink-0 text-xs text-zinc-500 tabular-nums">{fmt(currentTime)}</span>
              <Timeline
                currentTime={currentTime}
                duration={duration}
                onSeek={(t) => {
                  if (!isExporting && videoRef.current) videoRef.current.currentTime = t;
                  if (!isExporting) setCurrentTime(t);
                }}
              />
              <span className="flex-shrink-0 text-xs text-zinc-500 tabular-nums">{fmt(duration)}</span>
            </div>
          </div>
        )}
      </div>

      {/* Export modal */}
      {exportModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8 flex flex-col items-center gap-6 w-72 relative">
            {exportDone && (
              <button
                onClick={handleCreateAnother}
                className="absolute top-4 right-4 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                aria-label="Close"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
            {!exportDone ? (
              <>
                <CircleProgress progress={exportProgress} />
                <p className="text-sm text-zinc-400">
                  {loadingPhase || "Exporting your video…"}
                </p>
                <button
                  onClick={() => {
                    if (!confirm("Cancel the export?")) return;
                    abortRef.current = true;
                    setLoadingPhase("");
                    setIsExporting(false);
                    setExportProgress(0);
                    setExportModalOpen(false);
                  }}
                  className="text-xs text-red-400 hover:text-red-300 cursor-pointer transition-colors"
                >
                  Cancel export
                </button>
              </>
            ) : (
              <>
                <CircleProgress progress={100} />
                <p className="text-sm text-zinc-300 font-medium">Export complete</p>
                <div className="flex flex-col gap-2 w-full">
                  <button
                    onClick={handleDownload}
                    className="w-full py-2.5 rounded-xl bg-yellow-400 text-black text-sm font-semibold hover:bg-yellow-300 transition-colors cursor-pointer"
                  >
                    Download
                  </button>
                  <button
                    onClick={handleCreateAnother}
                    className="w-full py-2.5 rounded-xl bg-zinc-800 text-zinc-300 text-sm font-medium hover:bg-zinc-700 transition-colors cursor-pointer flex items-center justify-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                    Create another video
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
    </div>
  );
}
