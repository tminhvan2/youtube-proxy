const ALLOWED_ORIGINS = [
  'https://engdom.com', 'https://www.engdom.com',
  'http://localhost:5173', 'http://localhost:4173',
  'http://localhost:5175', 'http://localhost:5176', 'http://localhost:5177',
];

function getCorsOrigin(o) {
  if (!o) return ALLOWED_ORIGINS[0];
  if (ALLOWED_ORIGINS.includes(o)) return o;
  if (o.endsWith('.devtunnels.ms') || o === 'capacitor://localhost' || o === 'ionic://localhost') return o;
  return ALLOWED_ORIGINS[0];
}

const AV = '20.10.38';
const AUA = `com.google.android.youtube/${AV} (Linux; U; Android 14)`;
const WUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function viaInnerTube(videoId) {
  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': AUA },
      body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: AV } }, videoId }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const t = d?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(t) || !t.length) return null;
    return { tracks: t, title: d?.videoDetails?.title || '', dur: parseInt(d?.videoDetails?.lengthSeconds || '0', 10) };
  } catch { return null; }
}

async function viaWebPage(videoId) {
  try {
    const r = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'User-Agent': WUA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1' },
    });
    if (!r.ok) return null;
    const h = await r.text();
    if (h.includes('class="g-recaptcha"')) throw new Error('CAPTCHA');
    const mk = 'var ytInitialPlayerResponse = ';
    let ix = h.indexOf(mk), js;
    if (ix !== -1) { js = ix + mk.length; }
    else { ix = h.indexOf('ytInitialPlayerResponse'); if (ix === -1) return null; js = h.indexOf('{', ix); if (js === -1) return null; }
    let dp = 0, en = -1;
    for (let i = js; i < h.length; i++) { if (h[i] === '{') dp++; else if (h[i] === '}') dp--; if (dp === 0) { en = i; break; } }
    if (en === -1) return null;
    const d = JSON.parse(h.substring(js, en + 1));
    const t = d?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(t) || !t.length) return null;
    return { tracks: t, title: d?.videoDetails?.title || '', dur: parseInt(d?.videoDetails?.lengthSeconds || '0', 10) };
  } catch (e) { if (e.message === 'CAPTCHA') throw e; return null; }
}

async function getCaps(tracks, lang) {
  lang = lang || 'en';
  const tk = tracks.find(t => t.languageCode === lang && !t.kind) || tracks.find(t => t.languageCode === lang) || tracks.find(t => !t.kind) || tracks[0];
  try { if (!new URL(tk.baseUrl).hostname.endsWith('.youtube.com')) return null; } catch { return null; }
  const r = await fetch(tk.baseUrl, { headers: { 'User-Agent': WUA } });
  if (!r.ok) return null;
  const x = await r.text();
  if (!x || x.length < 10) return null;
  let cues = pP(x);
  if (!cues.length) cues = pT(x);
  if (!cues.length) return null;
  return {
    cues, track: { languageCode: tk.languageCode, name: tk.name?.simpleText || tk.languageCode, kind: tk.kind || null },
    allTracks: tracks.map(t => ({ languageCode: t.languageCode, name: t.name?.simpleText || t.languageCode, kind: t.kind || null })),
  };
}

function pP(x) {
  const o = [], re = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g; let m;
  while ((m = re.exec(x)) !== null) {
    let t = ''; const sr = /<s[^>]*>([^<]*)<\/s>/g; let sm;
    while ((sm = sr.exec(m[3])) !== null) t += sm[1];
    if (!t) t = m[3].replace(/<[^>]+>/g, '');
    t = dc(t).trim(); if (t) o.push({ text: t, offset: +m[1], duration: +m[2] });
  }
  return o;
}

function pT(x) {
  const o = [], re = /<text\s+start="([^"]+)"\s+dur="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g; let m;
  while ((m = re.exec(x)) !== null) {
    const t = dc(m[3].replace(/<[^>]+>/g, '').replace(/\n/g, ' ')).trim();
    if (t) o.push({ text: t, offset: Math.round(parseFloat(m[1]) * 1000), duration: Math.round(parseFloat(m[2]) * 1000) });
  }
  return o;
}

function dc(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

module.exports = async function handler(req, res) {
  const origin = getCorsOrigin(req.headers.origin);
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const videoId = req.query.videoId;
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return res.status(400).json({ error: 'Invalid videoId' });

  try {
    let result = await viaInnerTube(videoId);
    let source = 'innertube-android';
    if (!result) { result = await viaWebPage(videoId); source = 'web-scrape'; }
    if (!result) return res.json({ success: false, hasCaptions: false, videoTitle: '', videoDuration: 0, message: 'Không thể truy cập video YouTube' });

    const cap = await getCaps(result.tracks, 'en');
    if (!cap) return res.json({
      success: false, hasCaptions: true, videoTitle: result.title, videoDuration: result.dur,
      message: 'Video có phụ đề nhưng không thể tải nội dung.',
      availableTracks: result.tracks.map(t => ({ languageCode: t.languageCode, name: t.name?.simpleText || t.languageCode, kind: t.kind || null })),
    });

    const cues = cap.cues.map((c, i) => ({ id: `yt-${i}`, text: c.text, start: c.offset / 1000, end: (c.offset + c.duration) / 1000, words: null }));
    let title = result.title;
    if (!title) { try { const o = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`); if (o.ok) title = (await o.json()).title || ''; } catch {} }

    return res.json({
      success: true, hasCaptions: true, videoTitle: title,
      videoDuration: result.dur || Math.ceil(cues[cues.length - 1].end),
      subtitleData: { cues, part: 0, version: '1.0', duration: cues[cues.length - 1].end, language: cap.track.languageCode || 'en', cue_count: cues.length, question_uuid: '', question_number: 0 },
      trackUsed: cap.track, availableTracks: cap.allTracks, source,
    });
  } catch (err) {
    if (err.message === 'CAPTCHA') return res.status(429).json({ error: 'YouTube yêu cầu xác minh CAPTCHA' });
    console.error('Caption error:', err);
    return res.status(500).json({ error: 'Failed: ' + (err.message || String(err)) });
  }
};