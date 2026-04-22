const ALLOWED_ORIGINS = [
  'https://ucan.vn', 'https://www.ucan.vn',
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
      body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: AV } }, videoId, contentCheckOk: true, racyCheckOk: true }),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const d = await r.json();
    const status = d?.playabilityStatus?.status;
    const t = d?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!Array.isArray(t) || !t.length) return { error: `status=${status}, reason=${d?.playabilityStatus?.reason || 'none'}` };
    return { tracks: t, title: d?.videoDetails?.title || '', dur: parseInt(d?.videoDetails?.lengthSeconds || '0', 10) };
  } catch (e) { return { error: e.message }; }
}

async function viaWebScrape(videoId) {
  try {
    const r = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'User-Agent': WUA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1' },
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const h = await r.text();
    if (h.includes('class="g-recaptcha"')) return { error: 'CAPTCHA' };
    const playerResult = extractJSON(h, 'var ytInitialPlayerResponse = ');
    if (playerResult) {
      const t = playerResult?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(t) && t.length) {
        return { tracks: t, title: playerResult?.videoDetails?.title || '', dur: parseInt(playerResult?.videoDetails?.lengthSeconds || '0', 10) };
      }
    }
    const initData = extractJSON(h, 'var ytInitialData = ');
    if (initData?.engagementPanels) {
      for (const panel of initData.engagementPanels) {
        const ep = panel?.engagementPanelSectionListRenderer;
        if (ep?.panelIdentifier !== 'engagement-panel-searchable-transcript') continue;
        const params = ep?.content?.continuationItemRenderer?.continuationEndpoint?.getTranscriptEndpoint?.params;
        if (params) return await fetchTranscript(params, videoId);
      }
    }
    const status = playerResult?.playabilityStatus?.status || 'unknown';
    return { error: `status=${status}, no tracks, no transcript panel` };
  } catch (e) { return { error: e.message }; }
}

function extractJSON(html, marker) {
  const ix = html.indexOf(marker);
  if (ix === -1) return null;
  const start = ix + marker.length;
  let depth = 0, end = -1;
  for (let i = start; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  try { return JSON.parse(html.substring(start, end + 1)); } catch { return null; }
}

async function fetchTranscript(params, videoId) {
  try {
    const r = await fetch('https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': WUA },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20250620.01.00' } }, params }),
    });
    if (!r.ok) return { error: `get_transcript HTTP ${r.status}` };
    const d = await r.json();
    const body = d?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.body?.transcriptBodyRenderer;
    if (body?.cueGroups) {
      const cues = [];
      for (const g of body.cueGroups) {
        const c = g?.transcriptCueGroupRenderer?.cues?.[0]?.transcriptCueRenderer;
        if (!c) continue;
        const text = (c.cue?.simpleText || '').trim();
        if (text) cues.push({ text, offset: parseInt(c.startOffsetMs || '0', 10), duration: parseInt(c.durationMs || '0', 10) });
      }
      if (cues.length) return await wrapCues(cues, videoId);
    }
    const segs = d?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer?.content?.transcriptSearchPanelRenderer?.body?.transcriptSegmentListRenderer?.initialSegments;
    if (segs) {
      const cues = [];
      for (const s of segs) {
        const sr = s?.transcriptSegmentRenderer;
        if (!sr) continue;
        const text = (sr?.snippet?.runs?.map(r => r.text).join('') || '').trim();
        const startMs = parseInt(sr?.startMs || '0', 10);
        const endMs = parseInt(sr?.endMs || '0', 10);
        if (text) cues.push({ text, offset: startMs, duration: endMs - startMs });
      }
      if (cues.length) return await wrapCues(cues, videoId);
    }
    return { error: 'get_transcript: no cue data' };
  } catch (e) { return { error: `get_transcript: ${e.message}` }; }
}

async function wrapCues(cues, videoId) {
  let title = '';
  try { const o = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`); if (o.ok) title = (await o.json()).title || ''; } catch {}
  return { cues, title, dur: Math.ceil((cues[cues.length - 1].offset + cues[cues.length - 1].duration) / 1000), source: 'get_transcript' };
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
  return { cues, track: { languageCode: tk.languageCode, name: tk.name?.simpleText || tk.languageCode, kind: tk.kind || null }, allTracks: tracks.map(t => ({ languageCode: t.languageCode, name: t.name?.simpleText || t.languageCode, kind: t.kind || null })) };
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
  const debug = req.query.debug === '1';
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return res.status(400).json({ error: 'Invalid videoId' });

  try {
    const dbg = {};

    let result = await viaInnerTube(videoId);
    let source = 'innertube-android';
    if (result?.tracks) { if (debug) dbg.android = 'OK'; }
    else { if (debug) dbg.android = result?.error || 'null'; result = null; }

    if (!result) {
      const ws = await viaWebScrape(videoId);
      if (ws?.tracks) { result = ws; source = 'web-scrape'; if (debug) dbg.webScrape = 'OK'; }
      else if (ws?.cues) {
        if (debug) dbg.webScrape = `get_transcript: ${ws.cues.length} cues`;
        const cues = ws.cues.map((c, i) => ({ id: `cue-${i + 1}`, text: c.text, start: c.offset / 1000, end: (c.offset + c.duration) / 1000, words: null }));
        return res.json({
          success: true, hasCaptions: true, videoTitle: ws.title || '',
          videoDuration: ws.dur || Math.ceil(cues[cues.length - 1].end),
          subtitleData: { cues, part: 0, version: '1.0', duration: cues[cues.length - 1].end, language: 'en', cue_count: cues.length, question_uuid: '', question_number: 0 },
          trackUsed: { languageCode: 'en', name: 'English', kind: null }, availableTracks: [], source: ws.source || 'get_transcript',
          ...(debug ? { debug: dbg } : {}),
        });
      } else { if (debug) dbg.webScrape = ws?.error || 'null'; }
    }

    if (!result) {
      let videoTitle = '';
      try { const o = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`); if (o.ok) videoTitle = (await o.json()).title || ''; } catch {}
      return res.json({ success: false, hasCaptions: false, videoTitle, videoDuration: 0, message: 'Không thể tự động trích xuất phụ đề. YouTube giới hạn truy cập từ server.', ...(debug ? { debug: dbg } : {}) });
    }

    const cap = await getCaps(result.tracks, 'en');
    if (!cap) return res.json({ success: false, hasCaptions: true, videoTitle: result.title, videoDuration: result.dur, message: 'Video có phụ đề nhưng không thể tải nội dung.', availableTracks: result.tracks.map(t => ({ languageCode: t.languageCode, name: t.name?.simpleText || t.languageCode, kind: t.kind || null })) });

    const cues = cap.cues.map((c, i) => ({ id: `cue-${i + 1}`, text: c.text, start: c.offset / 1000, end: (c.offset + c.duration) / 1000, words: null }));
    let title = result.title;
    if (!title) { try { const o = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`); if (o.ok) title = (await o.json()).title || ''; } catch {} }

    return res.json({
      success: true, hasCaptions: true, videoTitle: title,
      videoDuration: result.dur || Math.ceil(cues[cues.length - 1].end),
      subtitleData: { cues, part: 0, version: '1.0', duration: cues[cues.length - 1].end, language: cap.track.languageCode || 'en', cue_count: cues.length, question_uuid: '', question_number: 0 },
      trackUsed: cap.track, availableTracks: cap.allTracks, source,
    });
  } catch (err) {
    console.error('Caption error:', err);
    return res.status(500).json({ error: 'Failed: ' + (err.message || String(err)) });
  }
};
