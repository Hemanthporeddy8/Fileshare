'use client';

/**
 * FileShare — editroy.com/share
 *
 * Zero extra npm packages needed.
 * QR code generated using qrcode.js loaded from CDN at runtime.
 * Signaling via Fly.io WebSocket — free, always-on, never stores anything.
 * File transfer via WebRTC P2P — browser to browser, never touches a server.
 */

import { useState, useRef, useEffect, DragEvent, ChangeEvent } from 'react';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
// After deploying signal server, add this to Vercel environment variables:
//   Name:  NEXT_PUBLIC_SIGNAL_URL
//   Value: wss://your-app-name.fly.dev
const SIGNAL = (process.env.NEXT_PUBLIC_SIGNAL_URL ?? 'wss://fileshare-signal.fly.dev') + '/ws';

// ─── WebRTC config ────────────────────────────────────────────────────────────
const ICE = {
  iceServers: [
    // Google STUN — free, works across all countries
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    // Open Relay TURN — free, handles corporate firewalls and strict NATs
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username:   'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

const CHUNK   = 256 * 1024;
const MAX_BUF = 8   * 1024 * 1024;
const P2P_TO  = 20_000;
const CHARS   = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

type Phase = 'home'|'send-pick'|'send-wait'|'send-transfer'|'send-done'|'recv-input'|'recv-wait'|'recv-accept'|'recv-transfer'|'recv-done'|'error';
interface Meta { name: string; size: number; mimeType: string }

const genCode   = () => Array.from({ length: 6 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
const fmtBytes  = (b: number) => { if (!b) return '—'; if (b < 1024) return `${b} B`; if (b < 1048576) return `${(b/1024).toFixed(1)} KB`; if (b < 1073741824) return `${(b/1048576).toFixed(1)} MB`; return `${(b/1073741824).toFixed(2)} GB`; };
const fmtSpeed  = (s: number) => s < 1048576 ? `${(s/1024).toFixed(0)} KB/s` : `${(s/1048576).toFixed(1)} MB/s`;
const fmtEta    = (s: number) => s < 60 ? `${s}s left` : `${Math.round(s/60)}m left`;
const mimeEmoji = (t = '') => { if (t.startsWith('image')) return '🖼️'; if (t.startsWith('video')) return '🎬'; if (t.startsWith('audio')) return '🎵'; if (t.includes('pdf')) return '📄'; if (t.includes('zip')||t.includes('tar')||t.includes('rar')) return '📦'; if (t.startsWith('text')) return '📝'; return '📁'; };

// ─── QR via CDN — no npm package ──────────────────────────────────────────────
// Loads qrcode.js from jsDelivr CDN on first use, then caches it
let qrLib: { toDataURL: (text: string, opts: object) => Promise<string> } | null = null;

async function makeQR(url: string): Promise<string> {
  if (!qrLib) {
    await new Promise<void>((resolve, reject) => {
      if (document.getElementById('qrcode-cdn')) { resolve(); return; }
      const s  = document.createElement('script');
      s.id     = 'qrcode-cdn';
      s.src    = 'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js';
      s.onload = () => resolve();
      s.onerror= () => reject();
      document.head.appendChild(s);
    });
    qrLib = (window as unknown as { QRCode: typeof qrLib }).QRCode!;
  }
  return qrLib!.toDataURL(url, { width: 140, margin: 1, color: { dark: '#07070e', light: '#22d3ee' } });
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function FileSharePage() {
  const [phase,    setPhase]    = useState<Phase>('home');
  const [code,     setCode]     = useState('');
  const [inCode,   setInCode]   = useState('');
  const [file,     setFile]     = useState<File | null>(null);
  const [meta,     setMeta]     = useState<Meta | null>(null);
  const [progress, setProgress] = useState(0);
  const [speed,    setSpeed]    = useState(0);
  const [eta,      setEta]      = useState(0);
  const [status,   setStatus]   = useState('');
  const [errMsg,   setErrMsg]   = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [qr,       setQr]       = useState('');

  const wsRef  = useRef<WebSocket | null>(null);
  const pcRef  = useRef<RTCPeerConnection | null>(null);
  const dcRef  = useRef<RTCDataChannel   | null>(null);
  const chunks = useRef<ArrayBuffer[]>([]);
  const rcvd   = useRef(0);
  const ptimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pIce   = useRef<RTCIceCandidateInit[]>([]);
  const done   = useRef(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('code')?.toUpperCase().slice(0, 6);
    if (q && /^[A-Z0-9]{6}$/.test(q)) startRecv(q);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => { cleanup(); }, []);

  function cleanup() {
    done.current = true;
    if (ptimer.current) clearTimeout(ptimer.current);
    wsRef.current?.close();
    pcRef.current?.close();
    wsRef.current = null; pcRef.current = null; dcRef.current = null; pIce.current = [];
  }

  function copyText(text: string, btn: HTMLButtonElement) {
    navigator.clipboard.writeText(text).then(() => {
      const o = btn.textContent; btn.textContent = '✓'; btn.style.color = '#34d399';
      setTimeout(() => { btn.textContent = o; btn.style.color = ''; }, 2000);
    });
  }

  function saveBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a   = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function addIce(c: RTCIceCandidateInit) {
    const pc = pcRef.current; if (!pc) return;
    if (pc.remoteDescription) { try { await pc.addIceCandidate(c); } catch {} }
    else pIce.current.push(c);
  }

  async function setRemote(sdp: RTCSessionDescriptionInit) {
    const pc = pcRef.current; if (!pc) return;
    await pc.setRemoteDescription(sdp).catch(() => {});
    for (const c of pIce.current) { try { await pc.addIceCandidate(c); } catch {} }
    pIce.current = [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SENDER
  // ═══════════════════════════════════════════════════════════════════════════
  async function startSend(f: File) {
    cleanup(); done.current = false; chunks.current = [];

    const roomCode = genCode();
    const shareUrl = `${window.location.origin}${window.location.pathname}?code=${roomCode}`;

    setCode(roomCode); setFile(f); setPhase('send-wait');
    setProgress(0); setSpeed(0); setEta(0); setQr('');

    // Generate QR using CDN — no npm install needed
    makeQR(shareUrl).then(setQr).catch(() => {});

    const ws = new WebSocket(`${SIGNAL}?code=${roomCode}&role=sender`);
    wsRef.current = ws;

    ws.onopen = async () => {
      setStatus('Waiting — share the code or QR with the receiver');

      const pc = new RTCPeerConnection(ICE);
      pcRef.current = pc;
      const dc = pc.createDataChannel('file', { ordered: true });
      dcRef.current = dc; dc.binaryType = 'arraybuffer';

      ptimer.current = setTimeout(() => {
        if (!done.current) {
          setErrMsg('P2P timed out. Ask receiver to try a different network. Cloudflare relay will be added soon as fallback.');
          setPhase('error');
        }
      }, P2P_TO);

      pc.onicecandidate = ({ candidate }) => {
        if (candidate && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ice', candidate }));
      };

      pc.onconnectionstatechange = () => {
        if (['disconnected','failed','closed'].includes(pc.connectionState) && !done.current)
          setStatus('Connection lost.');
      };

      dc.onopen = () => {
        clearTimeout(ptimer.current!);
        dc.send(JSON.stringify({ type: 'meta', name: f.name, size: f.size, mimeType: f.type || 'application/octet-stream' }));
        setStatus('Receiver is reviewing the file…');
      };

      dc.onmessage = (e) => {
        if (typeof e.data !== 'string') return;
        const msg = JSON.parse(e.data);
        if (msg.type === 'accept') {
          setPhase('send-transfer');
          setStatus('Sending via P2P…');
          sendChunks(dc, f);
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
    };

    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'answer')   { setStatus('Receiver connected — forming P2P…'); await setRemote(msg.sdp); }
      if (msg.type === 'ice')      await addIce(msg.candidate);
      if (msg.type === 'peer-left' && !done.current) setStatus('Receiver disconnected.');
    };

    ws.onerror = () => {
      if (!done.current) { setErrMsg('Cannot reach signal server. Check NEXT_PUBLIC_SIGNAL_URL in Vercel env vars.'); setPhase('error'); }
    };
  }

  function sendChunks(dc: RTCDataChannel, f: File) {
    let off = 0, lastB = 0, lastT = Date.now();
    const tick = () => {
      if (off >= f.size) {
        dc.send(JSON.stringify({ type: 'done' }));
        done.current = true; cleanup(); setPhase('send-done'); return;
      }
      if (dc.bufferedAmount > MAX_BUF) {
        dc.bufferedAmountLowThreshold = MAX_BUF / 2;
        dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; tick(); }; return;
      }
      f.slice(off, off + CHUNK).arrayBuffer().then(buf => {
        dc.send(buf); off += buf.byteLength;
        const now = Date.now(), dt = now - lastT;
        if (dt >= 400) { const s = ((off - lastB) / dt) * 1000; setSpeed(s); setEta(s > 0 ? Math.round((f.size - off) / s) : 0); lastB = off; lastT = now; }
        setProgress(off / f.size); tick();
      });
    };
    tick();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RECEIVER
  // ═══════════════════════════════════════════════════════════════════════════
  function startRecv(roomCode: string) {
    cleanup(); done.current = false; chunks.current = []; rcvd.current = 0;
    setCode(roomCode); setPhase('recv-wait'); setStatus('Connecting to sender…');

    const ws = new WebSocket(`${SIGNAL}?code=${roomCode}&role=receiver`);
    wsRef.current = ws;

    ws.onopen = () => setStatus('Connected — waiting for sender…');

    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === 'offer') {
        setStatus('Sender found — forming P2P…');
        const pc = new RTCPeerConnection(ICE); pcRef.current = pc;

        pc.onicecandidate = ({ candidate }) => {
          if (candidate && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ice', candidate }));
        };

        pc.ondatachannel = ({ channel: dc }) => {
          dcRef.current = dc; dc.binaryType = 'arraybuffer'; setStatus('P2P connected!');

          dc.onmessage = (e) => {
            const d = e.data;
            if (typeof d === 'string') {
              const m = JSON.parse(d);
              if (m.type === 'meta') { setMeta({ name: m.name, size: m.size, mimeType: m.mimeType }); setPhase('recv-accept'); setStatus('File ready — click Accept to download'); }
              if (m.type === 'done') {
                const blob = new Blob(chunks.current, { type: m.mimeType || 'application/octet-stream' });
                saveBlob(blob, m.name); done.current = true; cleanup(); setPhase('recv-done');
              }
            } else {
              chunks.current.push(d as ArrayBuffer); rcvd.current += (d as ArrayBuffer).byteLength;
              setMeta(prev => { if (prev?.size) setProgress(rcvd.current / prev.size); return prev; });
            }
          };
        };

        await pc.setRemoteDescription(msg.sdp).catch(() => {});
        for (const c of pIce.current) { try { await pc.addIceCandidate(c); } catch {} } pIce.current = [];
        const ans = await pc.createAnswer().catch(() => null); if (!ans) return;
        await pc.setLocalDescription(ans);
        ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
      }

      if (msg.type === 'ice') await addIce(msg.candidate);
      if (msg.type === 'peer-left') setStatus('Sender disconnected.');
    };

    ws.onerror = () => {
      if (!done.current) { setErrMsg('Cannot reach signal server. Check NEXT_PUBLIC_SIGNAL_URL in Vercel env vars.'); setPhase('error'); }
    };
  }

  function acceptDownload() {
    chunks.current = []; rcvd.current = 0; setPhase('recv-transfer');
    dcRef.current?.send(JSON.stringify({ type: 'accept' })); setStatus('Receiving…');
  }

  const onDragOver  = (e: DragEvent) => { e.preventDefault(); setDragOver(true); };
  const onDragLeave = () => setDragOver(false);
  const onDrop      = (e: DragEvent) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) startSend(f); };
  const onPick      = (e: ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) startSend(f); };

  const shareUrl = code
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}${typeof window !== 'undefined' ? window.location.pathname : '/share'}?code=${code}`
    : '';

  // ═══════════════════════════════════════════════════════════════════════════
  //  UI
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div style={S.wrap}>
      <header style={S.hdr}>
        <div style={S.logoRow}>
          <span style={S.logoIco}><svg width="17" height="17" viewBox="0 0 17 17" fill="none"><path d="M8.5 1.5v11M3.5 7l5-5.5 5 5.5" stroke="#07070e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M1.5 15.5h14" stroke="#07070e" strokeWidth="2" strokeLinecap="round"/></svg></span>
          <span style={S.logoTxt}>FileShare</span>
        </div>
        <p style={S.tag}>P2P · any size · files never stored</p>
      </header>

      {phase === 'home' && (
        <div style={S.card}><div style={S.g2}>
          <button style={S.modeBtn} onClick={() => setPhase('send-pick')}><div style={{ fontSize: '2rem', marginBottom: '.5rem' }}>⬆️</div><div style={S.mLbl}>Send</div><div style={S.mSub}>Pick a file</div></button>
          <button style={S.modeBtn} onClick={() => setPhase('recv-input')}><div style={{ fontSize: '2rem', marginBottom: '.5rem' }}>⬇️</div><div style={S.mLbl}>Receive</div><div style={S.mSub}>Enter a code</div></button>
        </div></div>
      )}

      {phase === 'send-pick' && (
        <div style={S.card}>
          <Bar title="Send a file" back={() => setPhase('home')} />
          <div style={{ ...S.dz, ...(dragOver ? S.dzOn : {}) }} onClick={() => document.getElementById('fs-inp')?.click()} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
            <svg width="44" height="44" viewBox="0 0 44 44" fill="none" style={{ color: '#22d3ee', marginBottom: '1rem' }}><path d="M22 8v22M12 18l10-10 10 10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M8 36h28" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg>
            <div style={S.dzT}>Drop your file here</div>
            <div style={S.dzS}>or <span style={{ color: '#22d3ee' }}>click to browse</span> — any size, any type</div>
            <input id="fs-inp" type="file" style={{ display: 'none' }} onChange={onPick} />
          </div>
        </div>
      )}

      {phase === 'send-wait' && file && (
        <div style={S.card}>
          <div style={{ ...S.rsb, marginBottom: '1rem' }}>
            <span style={{ ...S.badge, ...S.bBlue }}><Dot c="blue" /> Waiting for receiver</span>
            <button style={S.ghost} onClick={() => { cleanup(); setPhase('send-pick'); }}>Cancel</button>
          </div>
          <FRow name={file.name} size={file.size} type={file.type} />
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={S.codeBox}><div><div style={S.codeLbl}>Share this code</div><div style={S.codeVal}>{code}</div></div><button style={S.ghost} onClick={e => copyText(code, e.currentTarget)}>Copy</button></div>
              <div style={S.secLbl}>Or copy this link</div>
              <div style={S.linkRow}><span style={S.linkUrl}>{shareUrl}</span><button style={S.ghost} onClick={e => copyText(shareUrl, e.currentTarget)}>Copy</button></div>
            </div>
            {qr && <div style={{ flexShrink: 0, textAlign: 'center' }}><div style={S.qrWrap}><img src={qr} alt="QR code" width={130} height={130} /></div><div style={{ fontSize: '.62rem', color: '#718096', marginTop: '.3rem' }}>Scan to receive</div></div>}
          </div>
          <St msg={status || 'Connecting…'} c="yellow" />
        </div>
      )}

      {(phase === 'send-transfer' || phase === 'recv-transfer') && (
        <div style={S.card}>
          <div style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
            <div style={{ fontSize: '2rem', marginBottom: '.5rem' }}>{phase === 'send-transfer' ? '⬆️' : '⬇️'}</div>
            <div style={S.heading}>{phase === 'send-transfer' ? 'Sending…' : 'Receiving…'}</div>
            <div style={{ fontSize: '.75rem', color: '#718096', marginTop: '.25rem' }}>⚡ Direct P2P — file never touches a server</div>
          </div>
          <div style={S.pWrap}>
            <div style={S.pRow}>
              <span style={{ fontSize: '.73rem', color: '#718096' }}>{speed > 0 ? fmtSpeed(speed) : ''}{speed > 0 && eta > 0 ? '  ·  ' : ''}{eta > 0 ? fmtEta(eta) : ''}</span>
              <span style={{ fontFamily: 'monospace', fontSize: '.73rem' }}>{Math.round(progress * 100)}%</span>
            </div>
            <div style={S.pTrack}><div style={{ ...S.pFill, width: `${(Math.min(progress, 1) * 100).toFixed(1)}%` }} /></div>
          </div>
        </div>
      )}

      {phase === 'send-done' && file && (
        <div style={{ ...S.card, textAlign: 'center' }}>
          <div style={{ fontSize: '2.8rem', marginBottom: '.75rem' }}>✅</div>
          <div style={{ ...S.heading, marginBottom: '.4rem' }}>File sent!</div>
          <p style={{ fontSize: '.8rem', color: '#718096', marginBottom: '1.25rem' }}><strong>{file.name}</strong> ({fmtBytes(file.size)})</p>
          <div style={{ marginBottom: '1.25rem' }}><span style={{ ...S.badge, ...S.bGreen }}>⚡ Direct P2P — never touched a server</span></div>
          <button style={S.btnP} onClick={() => { cleanup(); setPhase('send-pick'); }}>Send another</button>
          <button style={{ ...S.ghost, width: '100%', marginTop: '.75rem' }} onClick={() => { cleanup(); setPhase('home'); }}>← Home</button>
        </div>
      )}

      {phase === 'recv-input' && (
        <div style={S.card}>
          <Bar title="Receive a file" back={() => setPhase('home')} />
          <div style={S.secLbl}>Enter the 6-character code from the sender</div>
          <input style={S.codeInput} value={inCode} maxLength={6} placeholder="ABC123" autoFocus
            onChange={e => setInCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            onKeyDown={e => e.key === 'Enter' && inCode.length === 6 && startRecv(inCode)} />
          <button style={{ ...S.btnP, opacity: inCode.length !== 6 ? .45 : 1 }} disabled={inCode.length !== 6} onClick={() => startRecv(inCode)}>Connect →</button>
        </div>
      )}

      {(phase === 'recv-wait' || phase === 'recv-accept') && (
        <div style={S.card}>
          <div style={{ ...S.rsb, marginBottom: '1rem' }}>
            <span style={{ ...S.badge, ...S.bBlue }}><Dot c="blue" /> {phase === 'recv-wait' ? 'Connecting…' : 'File ready'}</span>
            <button style={S.ghost} onClick={() => { cleanup(); setPhase('home'); }}>Cancel</button>
          </div>
          <div style={S.codeBox}><div><div style={S.codeLbl}>Room code</div><div style={S.codeVal}>{code}</div></div></div>
          {meta && <><FRow name={meta.name} size={meta.size} type={meta.mimeType} /><button style={S.btnP} onClick={acceptDownload}>⬇️ Accept &amp; Download</button></>}
          <St msg={status} c={phase === 'recv-accept' ? 'green' : 'yellow'} />
        </div>
      )}

      {phase === 'recv-done' && meta && (
        <div style={{ ...S.card, textAlign: 'center' }}>
          <div style={{ fontSize: '2.8rem', marginBottom: '.75rem' }}>⬇️</div>
          <div style={{ ...S.heading, marginBottom: '.4rem' }}>Download complete</div>
          <p style={{ fontSize: '.8rem', color: '#718096', marginBottom: '1.25rem' }}><strong>{meta.name}</strong> ({fmtBytes(meta.size)}) saved</p>
          <div style={{ marginBottom: '1.25rem' }}><span style={{ ...S.badge, ...S.bGreen }}>⚡ Direct P2P — never touched a server</span></div>
          <button style={S.btnP} onClick={() => { cleanup(); setPhase('recv-input'); }}>Receive another</button>
          <button style={{ ...S.ghost, width: '100%', marginTop: '.75rem' }} onClick={() => { cleanup(); setPhase('home'); }}>← Home</button>
        </div>
      )}

      {phase === 'error' && (
        <div style={S.card}>
          <div style={{ fontSize: '2.5rem', textAlign: 'center', marginBottom: '.75rem' }}>⚠️</div>
          <div style={{ ...S.heading, textAlign: 'center', marginBottom: '.5rem' }}>Connection failed</div>
          <p style={{ fontSize: '.82rem', color: '#718096', textAlign: 'center', marginBottom: '1.5rem', lineHeight: 1.6 }}>{errMsg}</p>
          <button style={S.btnP} onClick={() => { cleanup(); setPhase('home'); }}>Try Again</button>
        </div>
      )}

      <footer style={S.footer}>Files travel directly between browsers — never saved on any server.</footer>
    </div>
  );
}

function Bar({ title, back }: { title: string; back: () => void }) {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}><span style={{ fontFamily: 'Syne,sans-serif', fontSize: '1rem', fontWeight: 700 }}>{title}</span><button style={S.ghost} onClick={back}>← Back</button></div>;
}
function FRow({ name, size, type }: { name: string; size: number; type: string }) {
  return <div style={S.fileRow}><span style={{ fontSize: '1.5rem' }}>{mimeEmoji(type)}</span><div><div style={S.fileName}>{name}</div><div style={S.fileMeta}>{fmtBytes(size)}</div></div></div>;
}
function Dot({ c }: { c: 'blue' | 'green' | 'yellow' }) {
  return <span style={{ width: 7, height: 7, borderRadius: '50%', background: c === 'blue' ? '#22d3ee' : c === 'green' ? '#34d399' : '#fbbf24', display: 'inline-block', flexShrink: 0 }} />;
}
function St({ msg, c }: { msg: string; c: 'blue' | 'green' | 'yellow' }) {
  if (!msg) return null;
  return <div style={S.stLine}><Dot c={c} /><span>{msg}</span></div>;
}

const S: Record<string, React.CSSProperties> = {
  wrap:      { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem', background: '#07070e', backgroundImage: 'linear-gradient(rgba(34,211,238,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(34,211,238,.025) 1px,transparent 1px)', backgroundSize: '38px 38px', fontFamily: "'DM Sans',system-ui,sans-serif", color: '#f0f4ff' },
  hdr:       { textAlign: 'center', marginBottom: '2rem', width: '100%', maxWidth: 500 },
  logoRow:   { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '.6rem', marginBottom: '.35rem' },
  logoIco:   { width: 32, height: 32, background: '#22d3ee', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  logoTxt:   { fontFamily: 'Syne,sans-serif', fontSize: '1.25rem', fontWeight: 800, letterSpacing: '-.02em' },
  tag:       { fontSize: '.74rem', color: '#718096', letterSpacing: '.05em', textTransform: 'uppercase' },
  card:      { width: '100%', maxWidth: 500, background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.09)', borderRadius: 16, padding: '2rem', backdropFilter: 'blur(12px)', marginBottom: '.5rem' },
  g2:        { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' },
  modeBtn:   { background: 'rgba(255,255,255,.04)', border: '1px solid rgba(255,255,255,.09)', borderRadius: 16, padding: '1.75rem 1rem', cursor: 'pointer', textAlign: 'center', color: '#f0f4ff' },
  mLbl:      { fontFamily: 'Syne,sans-serif', fontSize: '.95rem', fontWeight: 700 },
  mSub:      { fontSize: '.72rem', color: '#718096', marginTop: '.2rem' },
  heading:   { fontFamily: 'Syne,sans-serif', fontSize: '1rem', fontWeight: 700 },
  rsb:       { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  dz:        { border: '2px dashed rgba(255,255,255,.09)', borderRadius: 10, padding: '2.75rem 1.5rem', textAlign: 'center', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', transition: 'all .2s' },
  dzOn:      { borderColor: '#22d3ee', borderStyle: 'solid', background: 'rgba(34,211,238,.07)' },
  dzT:       { fontFamily: 'Syne,sans-serif', fontSize: '1rem', fontWeight: 700, marginBottom: '.25rem' },
  dzS:       { fontSize: '.78rem', color: '#4a5568' },
  fileRow:   { background: '#0d0d1a', border: '1px solid rgba(255,255,255,.09)', borderRadius: 10, padding: '.85rem .95rem', display: 'flex', alignItems: 'center', gap: '.85rem', margin: '.85rem 0' },
  fileName:  { fontFamily: 'monospace', fontSize: '.8rem', color: '#22d3ee', wordBreak: 'break-all', fontWeight: 500 },
  fileMeta:  { fontSize: '.7rem', color: '#718096', marginTop: '.12rem' },
  codeBox:   { background: '#0d0d1a', border: '1px solid rgba(255,255,255,.09)', borderRadius: 10, padding: '.9rem 1.1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.75rem', margin: '.85rem 0' },
  codeLbl:   { fontSize: '.65rem', textTransform: 'uppercase', letterSpacing: '.08em', color: '#4a5568', marginBottom: '.2rem' },
  codeVal:   { fontFamily: 'monospace', fontSize: '1.75rem', fontWeight: 500, letterSpacing: '.22em' },
  codeInput: { background: '#0d0d1a', border: '1.5px solid rgba(255,255,255,.09)', borderRadius: 10, color: '#f0f4ff', fontFamily: 'monospace', fontSize: '1.9rem', fontWeight: 500, letterSpacing: '.2em', textAlign: 'center', padding: '.7rem', width: '100%', textTransform: 'uppercase', outline: 'none', margin: '.85rem 0' },
  secLbl:    { fontSize: '.65rem', textTransform: 'uppercase', letterSpacing: '.08em', color: '#4a5568', marginBottom: '.45rem' },
  linkRow:   { background: '#0d0d1a', border: '1px solid rgba(255,255,255,.09)', borderRadius: 8, padding: '.65rem .85rem', display: 'flex', alignItems: 'center', gap: '.5rem' },
  linkUrl:   { flex: 1, fontFamily: 'monospace', fontSize: '.7rem', color: '#718096', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  qrWrap:    { background: '#fff', borderRadius: 10, padding: 9, display: 'inline-block' },
  stLine:    { display: 'flex', alignItems: 'center', gap: '.5rem', fontSize: '.78rem', color: '#718096', padding: '.55rem .85rem', background: '#0d0d1a', border: '1px solid rgba(255,255,255,.09)', borderRadius: 8, margin: '.75rem 0' },
  pWrap:     { margin: '.85rem 0' },
  pRow:      { display: 'flex', justifyContent: 'space-between', marginBottom: '.4rem' },
  pTrack:    { height: 5, background: 'rgba(255,255,255,.09)', borderRadius: 99, overflow: 'hidden' },
  pFill:     { height: '100%', background: 'linear-gradient(90deg,#22d3ee,#818cf8)', borderRadius: 99, transition: 'width .1s ease' },
  btnP:      { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', padding: '.875rem 1.5rem', background: '#22d3ee', color: '#07070e', border: 'none', borderRadius: 10, fontWeight: 600, fontSize: '.9rem', cursor: 'pointer' },
  ghost:     { padding: '.38rem .8rem', fontSize: '.74rem', background: 'rgba(255,255,255,.04)', color: '#f0f4ff', border: '1px solid rgba(255,255,255,.09)', borderRadius: 8, cursor: 'pointer' },
  badge:     { display: 'inline-flex', alignItems: 'center', gap: '.38rem', padding: '.25rem .72rem', borderRadius: 99, fontSize: '.7rem', fontWeight: 500 },
  bGreen:    { background: 'rgba(52,211,153,.08)', border: '1px solid rgba(52,211,153,.2)', color: '#34d399' },
  bBlue:     { background: 'rgba(34,211,238,.1)', border: '1px solid rgba(34,211,238,.2)', color: '#22d3ee' },
  footer:    { textAlign: 'center', fontSize: '.73rem', color: '#4a5568', marginTop: '2rem', paddingBottom: '1.5rem', width: '100%', maxWidth: 500 },
};
