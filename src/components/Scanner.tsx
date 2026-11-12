// Barcode/QR input that works three ways:
//  1. Phone camera (native BarcodeDetector on Android; WebAssembly fallback on iPhone)
//  2. Bluetooth / USB barcode scanner (acts as a keyboard and presses Enter)
//  3. Typing the code by hand
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../lib/app';
import { useT } from '../lib/i18n';
import { Loading, Sheet } from './ui';

// ---------------------------------------------------------------------
// Scan override (testing only): a button on every scan box that "scans"
// a code picked from a list, so the workflows can be tried without labels,
// a camera or a scanner gun. Off on the live site unless an admin or
// manager turns it on for that device (More → Testing tools); on in demo.
// ---------------------------------------------------------------------
export type ScanHint = { code: string; label: string };
const OVERRIDE_KEY = 'tl-scan-override';
export function scanOverrideSetting(): boolean | null {
  try { const v = localStorage.getItem(OVERRIDE_KEY); return v === null ? null : v === '1'; } catch { return null; }
}
export function setScanOverride(on: boolean) {
  try { localStorage.setItem(OVERRIDE_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}
export function useScanOverride(): boolean {
  const { backend } = useApp();
  const v = scanOverrideSetting();
  return v ?? backend.mode === 'demo';
}

function ScanOverrideSheet({ hints, onPick, onClose }: { hints: ScanHint[]; onPick(code: string): void; onClose(): void }) {
  const { backend } = useApp();
  const { t } = useT();
  const [items, setItems] = useState<any[] | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<{ id: string; batches: any[] | null } | null>(null);
  useEffect(() => { backend.rpc<any[]>('inv_items').then(setItems).catch(() => setItems([])); }, [backend]);
  const expand = async (id: string) => {
    if (open?.id === id) { setOpen(null); return; }
    setOpen({ id, batches: null });
    try { const d = await backend.rpc<any>('inv_item', { p_sku_id: id }); setOpen({ id, batches: d.batches }); } catch { setOpen({ id, batches: [] }); }
  };
  const shown = (items ?? []).filter((i) => !q.trim() || i.name.toLowerCase().includes(q.trim().toLowerCase()) || i.code.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Sheet title={t('scan_override_title')} onClose={onClose}>
      {hints.length > 0 && (
        <>
          <div className="field-label">{t('suggested')}</div>
          <div className="override-list">
            {hints.map((h) => <button type="button" key={h.code + h.label} className="override-pick" onClick={() => onPick(h.code)}>
              <span>{h.label}</span><span className="mono small">{h.code}</span></button>)}
          </div>
        </>
      )}
      <div className="field-label">{t('all_items_barcodes')}</div>
      <input className="search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} />
      {!items && <Loading />}
      <div className="override-list">
        {shown.map((i) => (
          <div key={i.id} className="override-item">
            <button type="button" className="override-pick" onClick={() => expand(i.id)}>
              <span>{i.name}</span><span className="mono small">{i.code}</span>
            </button>
            {open?.id === i.id && (
              <div className="override-sub">
                <button type="button" className="btn btn-small" onClick={() => onPick(i.barcode)}>{t('product_barcode')} · <span className="mono">{i.barcode}</span></button>
                {open?.batches === null ? <Loading /> : (open?.batches?.length ?? 0) > 0 && <span className="small muted">{t('choose_batch')}</span>}
                {open?.batches?.filter((b: any) => b.id).map((b: any) => (
                  <button type="button" key={b.id} className="btn btn-small" onClick={() => onPick(b.code)}>
                    <span className="mono">{b.code}</span>&nbsp;· {Number(b.qty)}{b.expired ? ' · expired' : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </Sheet>
  );
}

type Detector = { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> };

const FORMATS = ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'code_128', 'code_39', 'data_matrix'];

async function makeDetector(): Promise<Detector> {
  const Native = (window as any).BarcodeDetector;
  if (Native) {
    try {
      const supported: string[] = await Native.getSupportedFormats();
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.length) return new Native({ formats });
    } catch { /* fall through */ }
  }
  const [{ BarcodeDetector, prepareZXingModule }, wasm] = await Promise.all([
    import('barcode-detector/ponyfill'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  prepareZXingModule({
    overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasm.default : prefix + path) },
  });
  return new BarcodeDetector({ formats: FORMATS as any });
}

export function Scanner({ onScan, placeholder = 'Scan or type a code', busy = false, autoFocus = true, cameraDefault = false, hints = [] }: {
  onScan(code: string): void; placeholder?: string; busy?: boolean; autoFocus?: boolean; cameraDefault?: boolean; hints?: ScanHint[];
}) {
  const overrideOn = useScanOverride();
  const [override, setOverride] = useState(false);
  const { t } = useT();
  const [text, setText] = useState('');
  const [camera, setCamera] = useState(cameraDefault);
  const [camError, setCamError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const last = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const emit = (raw: string, fromCamera = false) => {
    const code = raw.trim();
    if (!code || (fromCamera && busyRef.current)) return;
    const now = Date.now();
    // The camera sees the same label many times a second; a handheld scanner
    // or typed entry is always a deliberate scan, so it is never suppressed.
    if (fromCamera && code === last.current.code && now - last.current.at < 2500) return;
    last.current = { code, at: now };
    onScanRef.current(code);
  };

  useEffect(() => {
    if (!camera) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: number | undefined;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open the camera (it needs HTTPS).');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
        });
        if (stopped) return;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play();
        const detector = await makeDetector();
        const tick = async () => {
          if (stopped) return;
          try {
            if (v.readyState >= 2) {
              const codes = await detector.detect(v);
              if (codes[0]?.rawValue) emit(codes[0].rawValue, true);
            }
          } catch { /* frame not ready */ }
          timer = window.setTimeout(tick, 200);
        };
        tick();
        setCamError(null);
      } catch (e) {
        setCamError(e instanceof Error && e.name === 'NotAllowedError'
          ? 'Camera permission was refused. Allow camera access in the browser settings.'
          : e instanceof Error ? e.message : 'Could not start the camera.');
        setCamera(false);
      }
    })();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [camera]);

  return (
    <div className="scanner">
      {camera && (
        <div className="viewfinder">
          <video ref={videoRef} playsInline muted />
          <div className="aim" aria-hidden="true" />
        </div>
      )}
      <form className="scan-row" onSubmit={(e) => { e.preventDefault(); emit(text); setText(''); inputRef.current?.focus(); }}>
        <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder}
          autoFocus={autoFocus} autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="go"
          aria-label={placeholder} inputMode="text" />
        <button type="submit" className="btn" disabled={!text.trim()}>OK</button>
        <button type="button" className={`btn btn-camera ${camera ? 'on' : ''}`} onClick={() => setCamera((c) => !c)}
          aria-pressed={camera} aria-label={camera ? 'Turn camera off' : 'Scan with camera'}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M7 12h10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </form>
      {camError && <p className="field-hint bad">{camError}</p>}
      {overrideOn && (
        <button type="button" className="btn btn-small scan-override" onClick={() => setOverride(true)}>
          <span className="test-tag">TEST</span> {t('scan_override')}
        </button>
      )}
      {override && <ScanOverrideSheet hints={hints} onClose={() => setOverride(false)} onPick={(code) => { setOverride(false); if (code) emit(code); }} />}
    </div>
  );
}

// Short audible + haptic feedback so packers needn't look at the screen.
let audio: AudioContext | null = null;
export function feedback(ok: boolean) {
  try {
    navigator.vibrate?.(ok ? 60 : [120, 80, 120]);
    audio ??= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = ok ? 880 : 220;
    o.type = ok ? 'sine' : 'square';
    g.gain.setValueAtTime(0.12, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + (ok ? 0.12 : 0.35));
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + (ok ? 0.12 : 0.35));
  } catch { /* no audio */ }
}
