'use strict';

require('dotenv').config();

const express  = require('express');
const path     = require('path');
const { matcher, scanRepo, trimGraph, tokeniseDescription } = require('./analyzer');
const { diagnoseWithLLM } = require('./llm');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ---------------------------------------------------------------------------
// POST /api/diagnose
// Body: { repoPath: string, bugDescription: string, suspects: [...] }
// Returns: { rootCause, suggestedPatch, suggestedTest }
// ---------------------------------------------------------------------------
app.post('/api/diagnose', async (req, res) => {
  const { bugDescription, suspects } = req.body ?? {};

  if (!bugDescription || !Array.isArray(suspects)) {
    return res.status(400).json({ error: 'bugDescription and suspects are required.' });
  }

  try {
    const result = await diagnoseWithLLM(bugDescription, suspects);
    res.json(result);
  } catch (err) {
    console.error('[bug-tracer] diagnose error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/analyze
// Body: { repoPath: string, bugDescription: string }
// Returns: { suspects: [{file, score, reason}], mermaid: string }
// ---------------------------------------------------------------------------
app.post('/api/analyze', async (req, res) => {
  const { repoPath, bugDescription } = req.body ?? {};

  if (!repoPath || !bugDescription) {
    return res.status(400).json({ error: 'repoPath and bugDescription are required.' });
  }

  // Resolve relative paths against __dirname (the directory containing server.js),
  // not process.cwd(), so the path is stable regardless of where `npm start` is run.
  const absRepoPath = path.isAbsolute(repoPath)
    ? repoPath
    : path.resolve(__dirname, repoPath);

  console.log('[bug-tracer] process.cwd()      :', process.cwd());
  console.log('[bug-tracer] __dirname           :', __dirname);
  console.log('[bug-tracer] repoPath (raw)      :', repoPath);
  console.log('[bug-tracer] repoPath (resolved) :', absRepoPath);

  try {
    const [suspects, rawMermaid] = await Promise.all([
      matcher(absRepoPath, bugDescription),
      Promise.resolve(scanRepo(absRepoPath)),
    ]);

    // Keywords are attached to every suspect entry by matcher(); fall back to
    // tokenising the description directly in case the suspects list is empty.
    const keywords = suspects.length > 0
      ? suspects[0].keywords
      : tokeniseDescription(bugDescription);

    const rawNodeCount = rawMermaid.split('\n').length - 1;
    console.log('[bug-tracer] scanRepo node count (raw) :', rawNodeCount);
    console.log('[bug-tracer] suspects found            :', suspects.length);

    // Mermaid silently fails on large graphs (200+ nodes).  Trim to the 30
    // most-connected nodes server-side so the browser never receives a diagram
    // it cannot render.  Pass keywords so bug-relevant nodes are always kept.
    const GRAPH_LIMIT = 50;
    const mermaid = rawNodeCount > GRAPH_LIMIT
      ? trimGraph(rawMermaid, 30, keywords)
      : rawMermaid;

    if (rawNodeCount > GRAPH_LIMIT) {
      console.log('[bug-tracer] graph trimmed from', rawNodeCount, 'lines → top-30 nodes');
    }

    res.json({ suspects, mermaid, graphTrimmed: rawNodeCount > GRAPH_LIMIT, rawNodeCount });
  } catch (err) {
    console.error('[bug-tracer] analyze error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /  — single-page UI
// ---------------------------------------------------------------------------
app.get('/', (_req, res) => {
  res.send(HTML);
});

// ---------------------------------------------------------------------------
// HTML (self-contained, no external dependencies except Mermaid CDN)
// ---------------------------------------------------------------------------
const HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bug Tracer</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js" defer></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      background: #f7f8fa;
      color: #1f2328;
    }
    header {
      background: #1f2328;
      color: #fff;
      padding: 14px 24px;
      font-size: 17px;
      font-weight: 600;
      letter-spacing: .3px;
    }
    main {
      max-width: 860px;
      margin: 28px auto;
      padding: 0 20px;
    }
    label { display: block; font-weight: 600; margin-bottom: 4px; }
    .field { margin-bottom: 16px; }
    input[type="text"], textarea {
      width: 100%;
      padding: 9px 12px;
      border: 1px solid #d0d7de;
      border-radius: 6px;
      font-family: inherit;
      font-size: 14px;
      background: #fff;
      outline: none;
    }
    input[type="text"]:focus, textarea:focus { border-color: #3b82d4; }
    textarea { min-height: 90px; resize: vertical; }
    button {
      padding: 9px 22px;
      background: #3b82d4;
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    button:disabled { background: #9cb8e8; cursor: default; }
    #results { margin-top: 32px; }
    .panel {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 20px 24px;
      margin-bottom: 24px;
    }
    .panel h2 {
      margin: 0 0 14px;
      font-size: 15px;
      color: #1f2328;
      border-bottom: 1px solid #e5e7eb;
      padding-bottom: 8px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 6px 10px; background: #f7f8fa; border-bottom: 1px solid #e5e7eb; }
    td { padding: 7px 10px; border-bottom: 1px solid #f0f2f4; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    .rank { font-weight: 700; color: #57606a; width: 36px; }
    .score-badge {
      display: inline-block;
      padding: 1px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 700;
      background: #dbeafe;
      color: #1d4ed8;
      white-space: nowrap;
    }
    .score-high  { background: #fee2e2; color: #b91c1c; }
    .score-med   { background: #fef3c7; color: #92400e; }
    .score-low   { background: #dbeafe; color: #1d4ed8; }
    .file-name   { font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px; color: #0550ae; }
    .reason      { color: #57606a; font-size: 12px; }
    #mermaid-wrap { overflow-x: auto; }
    .error-msg { color: #b91c1c; padding: 12px 0; }
    /* AI Diagnosis panel */
    #ai-diagnosis { margin-bottom: 24px; }
    .diag-section { margin-bottom: 14px; }
    .diag-section h3 { font-size: 13px; font-weight: 700; color: #57606a; text-transform: uppercase; letter-spacing: .4px; margin: 0 0 6px; }
    .diag-content { background: #f7f8fa; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 14px; font-size: 13px; white-space: pre-wrap; word-break: break-word; }
    .diag-loading { color: #57606a; font-size: 13px; }
    .diag-error   { color: #b91c1c; font-size: 13px; }
    .spinner {
      display: inline-block;
      width: 16px; height: 16px;
      border: 2px solid #c4d4e9;
      border-top-color: #3b82d4;
      border-radius: 50%;
      animation: spin .7s linear infinite;
      vertical-align: middle;
      margin-right: 8px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    #status { margin-top: 12px; min-height: 20px; color: #57606a; font-size: 13px; }
  </style>
</head>
<body>
  <header>🐛 Bug Tracer</header>
  <main>
    <div class="field">
      <label for="repoPath">Repository path</label>
      <input type="text" id="repoPath" placeholder="/absolute/path/to/your/repo" spellcheck="false">
    </div>
    <div class="field">
      <label for="bugDesc">Bug description</label>
      <textarea id="bugDesc" placeholder="Describe the bug — e.g. &quot;payments fail when user has no saved card&quot; or &quot;login throws 500 on empty password&quot;"></textarea>
    </div>
    <button id="analyzeBtn" onclick="analyze()">Analyze</button>
    <div id="status"></div>
    <div id="results"></div>
  </main>

  <script>
    // The Mermaid CDN script loads with defer, so it is guaranteed to have
    // executed before DOMContentLoaded fires and before any inline onclick
    // handler runs.  Guard the initialize call in case the CDN is unreachable.
    if (typeof mermaid !== 'undefined') {
      mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
    }

    async function analyze() {
      const repoPath      = document.getElementById('repoPath').value.trim();
      const bugDescription = document.getElementById('bugDesc').value.trim();
      const btn    = document.getElementById('analyzeBtn');
      const status = document.getElementById('status');
      const out    = document.getElementById('results');

      if (!repoPath || !bugDescription) {
        status.innerHTML = '<span class="error-msg">Please fill in both fields.</span>';
        return;
      }

      btn.disabled = true;
      status.innerHTML = '<span class="spinner"></span>Analysing…';
      out.innerHTML = '';

      try {
        const resp = await fetch('/api/analyze', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ repoPath, bugDescription }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || resp.statusText);

        status.innerHTML = '';
        window._lastRepoPath = repoPath;
        window._lastBugDesc  = bugDescription;
        renderResults(data.suspects, data.mermaid, data.graphTrimmed, data.rawNodeCount);
      } catch (err) {
        status.innerHTML = '<span class="error-msg">Error: ' + escHtml(err.message) + '</span>';
      } finally {
        btn.disabled = false;
      }
    }

    function scoreCls(s) {
      if (s >= 0.5) return 'score-high';
      if (s >= 0.25) return 'score-med';
      return 'score-low';
    }

    function renderResults(suspects, mermaidSrc, graphTrimmed, rawNodeCount) {
      const out = document.getElementById('results');
      let html = '';

      // ── Suspects panel ──────────────────────────────────────────────────────
      if (!suspects || suspects.length === 0) {
        html += '<div class="panel"><h2>Suspect Files</h2><p style="color:#57606a">No matching files found. Try a more descriptive bug report.</p></div>';
      } else {
        html += '<div class="panel"><h2>Suspect Files</h2><table>';
        html += '<thead><tr><th class="rank">#</th><th>File</th><th>Score</th><th>Reason</th></tr></thead><tbody>';
        suspects.slice(0, 20).forEach((s, i) => {
          const cls = scoreCls(s.score);
          html += '<tr>';
          html += '<td class="rank">' + (i + 1) + '</td>';
          html += '<td class="file-name">' + escHtml(s.file) + '</td>';
          html += '<td><span class="score-badge ' + cls + '">' + s.score.toFixed(3) + '</span></td>';
          html += '<td class="reason">' + escHtml(s.reason) + '</td>';
          html += '</tr>';
        });
        html += '</tbody></table></div>';
      }

      // ── AI Diagnosis panel ──────────────────────────────────────────────────
      html += '<div class="panel" id="ai-diagnosis"><h2>AI Diagnosis</h2><div id="diag-inner"><div class="diag-loading"><span class="spinner"></span>Running AI diagnosis\u2026</div></div></div>';

      // ── Mermaid graph panel ─────────────────────────────────────────────────
      const graphSubtitle = graphTrimmed
        ? '<p style="color:#57606a;font-size:12px;margin:0 0 10px">Showing top 30 most-connected nodes of ' + rawNodeCount + ' total (graph trimmed for readability).</p>'
        : '';
      html += '<div class="panel"><h2>Dependency Graph</h2>' + graphSubtitle + '<div id="mermaid-wrap"><div class="mermaid" id="mermaid-graph"></div></div></div>';

      out.innerHTML = html;

      // Kick off AI diagnosis after the DOM is populated.
      if (suspects && suspects.length > 0) {
        loadDiagnosis(window._lastRepoPath, window._lastBugDesc, suspects);
      }

      // Log the raw Mermaid source so it can be inspected in the browser console
      console.log('[bug-tracer] mermaid source:', mermaidSrc);

      // Render mermaid after injection.
      // Use a unique id each call so Mermaid v10 never finds a stale SVG in the DOM.
      const el = document.getElementById('mermaid-graph');
      if (el && mermaidSrc) {
        const renderId = 'mermaid-svg-' + Date.now();
        // Remove any leftover hidden SVG Mermaid may have appended to <body>
        const stale = document.getElementById('mermaid-svg');
        if (stale) stale.remove();

        if (typeof mermaid === 'undefined') {
          el.textContent = 'Mermaid library unavailable (CDN load failed — check network).';
        } else {
          mermaid.render(renderId, mermaidSrc).then(({ svg }) => {
            el.innerHTML = svg;
          }).catch((e) => {
            // Mermaid v10 sometimes throws a plain string, not an Error object.
            const msg = (e instanceof Error) ? e.message : String(e);
            console.error('[bug-tracer] mermaid render error (full):', e);
            console.error('[bug-tracer] mermaid source that failed:\\n', mermaidSrc);
            el.textContent = 'Graph render error: ' + msg;
          });
        }
      }
    }

    async function loadDiagnosis(repoPath, bugDescription, suspects) {
      const diag = document.getElementById('diag-inner');
      if (!diag) return;
      try {
        const resp = await fetch('/api/diagnose', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ repoPath, bugDescription, suspects: suspects.slice(0, 5) }),
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || resp.statusText);

        diag.innerHTML =
          diagSection('Root Cause',      data.rootCause) +
          diagSection('Suggested Patch', data.suggestedPatch) +
          diagSection('Suggested Test',  data.suggestedTest);
      } catch (err) {
        diag.innerHTML = '<div class="diag-error">AI diagnosis unavailable: ' + escHtml(err.message) + '</div>';
      }
    }

    function diagSection(heading, text) {
      return '<div class="diag-section"><h3>' + escHtml(heading) + '</h3>'
           + '<div class="diag-content">' + escHtml(text || '(no output)') + '</div></div>';
    }

    function escHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Bug Tracer running at http://localhost:${PORT}`);
});
