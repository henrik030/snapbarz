"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import Image from "next/image";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

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

export default function VideoEditor() {
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [settings, setSettings] = useState<TextSettings>(DEFAULT_SETTINGS);
  const [isExporting, setIsExporting] = useState(false);
  const [ffmpegLoading, setFfmpegLoading] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportDone, setExportDone] = useState(false);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [exportFilename, setExportFilename] = useState("");
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const settingsRef = useRef(settings);
  const overlayGeometryRef = useRef({ barY: 0, barHeight: 0, canvasW: 0, canvasH: 0 });

  useEffect(() => { settingsRef.current = settings; }, [settings]);

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

  const loadFfmpeg = useCallback(async () => {
    if (ffmpegLoaded) return;
    setFfmpegLoading(true);
    try {
      const ffmpeg = new FFmpeg();
      const useMT = typeof SharedArrayBuffer !== "undefined";
      const pkg = useMT ? "@ffmpeg/core-mt" : "@ffmpeg/core";
      const baseURL = `https://unpkg.com/${pkg}@0.12.6/dist/umd`;
      console.log(`[ffmpeg] loading ${useMT ? "multi-threaded" : "single-threaded"} build`);
      const loadOpts: Parameters<FFmpeg["load"]>[0] = {
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
      };
      if (useMT) {
        loadOpts.workerURL = await toBlobURL(`${baseURL}/ffmpeg-core.worker.js`, "text/javascript");
      }
      await ffmpeg.load(loadOpts);
      ffmpegRef.current = ffmpeg;
      setFfmpegLoaded(true);
    } finally {
      setFfmpegLoading(false);
    }
  }, [ffmpegLoaded]);

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

    overlayGeometryRef.current = {
      barY,
      barHeight,
      canvasW: canvas.width,
      canvasH: canvas.height,
    };

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

    try {
      await loadFfmpeg();
      const ffmpeg = ffmpegRef.current!;

      const onProgress = ({ progress }: { progress: number }) => setExportProgress(Math.round(progress * 100));
      const onLog = ({ message }: { message: string }) => console.log("[ffmpeg]", message);
      ffmpeg.on("progress", onProgress);
      ffmpeg.on("log", onLog);

      // Write font files into FFmpeg virtual filesystem
      const fontFile = settings.italic ? "font-italic.ttf" : "font.ttf";
      await ffmpeg.writeFile("font.ttf", await fetchFile("/font/Inter-VariableFont_opsz,wght.ttf"));
      await ffmpeg.writeFile("font-italic.ttf", await fetchFile("/font/Inter-Italic-VariableFont_opsz,wght.ttf"));

      const inputExt = videoFile.name.substring(videoFile.name.lastIndexOf("."));
      const inputName = `input${inputExt}`;
      const outputName = `output${inputExt}`;
      await ffmpeg.writeFile(inputName, await fetchFile(videoFile));

      const { barY, barHeight, canvasH } = overlayGeometryRef.current;
      console.log("[export] overlay geometry:", overlayGeometryRef.current);
      if (canvasH === 0) throw new Error("Canvas not ready — try again after the video preview loads");

      const { barOpacity, fontSize, barPadding, text, bold } = settings;

      // Use real pixel integers — avoids FFmpeg expression parsing issues
      const barYPx = Math.round(barY);
      const barHPx = Math.round(barHeight);
      const textYPx = Math.round(barY + barPadding);

      const safeText = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
      const boldFlag = bold ? ":bold=1" : "";

      const filter = [
        `drawbox=x=0:y=${barYPx}:w=iw:h=${barHPx}:color=black@${barOpacity}:t=fill`,
        `drawtext=fontfile=${fontFile}:text='${safeText}':fontsize=${fontSize}:fontcolor=white:x=(w-text_w)/2:y=${textYPx}${boldFlag}`,
      ].join(",");

      console.log("[export] filter:", filter);

      const exitCode = await ffmpeg.exec(["-loglevel", "error", "-i", inputName, "-vf", filter, "-c:v", "libx264", "-preset", "fast", "-crf", "23", "-c:a", "copy", outputName]);
      if (exitCode !== 0) throw new Error(`FFmpeg exited with code ${exitCode}`);

      const data = await ffmpeg.readFile(outputName);
      const rawBytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data as string);
      if (rawBytes.length === 0) throw new Error("FFmpeg produced an empty file");

      const plain = new Uint8Array(rawBytes.length);
      plain.set(rawBytes);
      const blob = new Blob([plain.buffer], { type: videoFile.type });
      const url = URL.createObjectURL(blob);
      setExportUrl(url);
      setExportFilename(`captioned_${videoFile.name}`);
      setExportDone(true);
    } catch (err) {
      console.error("Export failed:", err);
      setExportModalOpen(false);
      alert("Export failed. Check the console for details.");
    } finally {
      setIsExporting(false);
      setExportProgress(0);
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
    <div className="flex flex-col md:flex-row h-screen">
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
            <div className="flex items-center gap-3 w-full px-1">
              <button
                onClick={togglePlay}
                className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full bg-white text-black cursor-pointer hover:bg-zinc-200 transition-colors"
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
                  if (videoRef.current) videoRef.current.currentTime = t;
                  setCurrentTime(t);
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
                  {ffmpegLoading ? "Loading FFmpeg…" : "Exporting your video…"}
                </p>
                <button
                  onClick={() => {
                    if (!confirm("Cancel the export?")) return;
                    ffmpegRef.current?.terminate();
                    ffmpegRef.current = null;
                    setFfmpegLoaded(false);
                    setFfmpegLoading(false);
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
  );
}
