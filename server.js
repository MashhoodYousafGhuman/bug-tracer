'use strict';

require('dotenv').config();

const express  = require('express');
const fs       = require('fs');
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

  if (!bugDescription.trim()) {
    return res.status(400).json({ error: 'bugDescription must not be blank.' });
  }

  // Resolve relative paths against __dirname (the directory containing server.js),
  // not process.cwd(), so the path is stable regardless of where `npm start` is run.
  const absRepoPath = path.isAbsolute(repoPath)
    ? repoPath
    : path.resolve(__dirname, repoPath);

  if (!fs.existsSync(absRepoPath)) {
    return res.status(400).json({ error: `repoPath does not exist on disk: ${absRepoPath}` });
  }

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
    /* ── Reset & base ─────────────────────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, "Segoe UI", Inter, system-ui, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      background: #f0f2f5;
      color: #1f2328;
    }

    /* ── Top nav bar ──────────────────────────────────────────────────────── */
    .nav-bar {
      background: #0f1117;
      color: #fff;
      padding: 0 28px;
      height: 52px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 15px;
      font-weight: 700;
      letter-spacing: .2px;
      border-bottom: 1px solid #1e2230;
    }
    .nav-logo {
      width: 26px; height: 26px;
      background: #3b82d4;
      border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px;
      flex-shrink: 0;
    }

    /* ── Hero section ─────────────────────────────────────────────────────── */
    .hero {
      background: linear-gradient(135deg, #0f1117 0%, #1a2236 100%);
      color: #fff;
      padding: 52px 28px 48px;
      text-align: center;
      border-bottom: 1px solid #1e2230;
    }
    .hero h1 {
      margin: 0 0 12px;
      font-size: clamp(24px, 4vw, 34px);
      font-weight: 800;
      letter-spacing: -.5px;
      line-height: 1.2;
    }
    .hero h1 span { color: #60a5fa; }
    .hero p {
      margin: 0 auto 20px;
      max-width: 520px;
      color: #a0aec0;
      font-size: 15px;
      line-height: 1.6;
    }
    .lang-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(255,255,255,.07);
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 20px;
      padding: 5px 14px;
      font-size: 12px;
      color: #cbd5e1;
      letter-spacing: .2px;
    }
    .lang-badge span { color: #93c5fd; font-weight: 600; }

    /* ── Main content ─────────────────────────────────────────────────────── */
    main {
      max-width: 880px;
      margin: 36px auto;
      padding: 0 24px;
    }

    /* ── Input form card ──────────────────────────────────────────────────── */
    .form-card {
      background: #fff;
      border: 1px solid #e2e5ea;
      border-radius: 12px;
      padding: 28px 28px 24px;
      box-shadow: 0 1px 4px rgba(0,0,0,.06), 0 4px 16px rgba(0,0,0,.04);
      margin-bottom: 8px;
    }
    label {
      display: block;
      font-weight: 600;
      font-size: 13px;
      color: #374151;
      margin-bottom: 6px;
      letter-spacing: .1px;
    }
    .field { margin-bottom: 18px; }
    .field:last-of-type { margin-bottom: 0; }
    input[type="text"], textarea {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-family: inherit;
      font-size: 14px;
      background: #fff;
      color: #1f2328;
      outline: none;
      transition: border-color .15s ease, box-shadow .15s ease;
    }
    input[type="text"]:focus, textarea:focus {
      border-color: #3b82d4;
      box-shadow: 0 0 0 3px rgba(59,130,212,.12);
    }
    textarea { min-height: 96px; resize: vertical; }

    /* ── Form footer row ──────────────────────────────────────────────────── */
    .form-footer {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-top: 20px;
      flex-wrap: wrap;
    }
    button#analyzeBtn {
      padding: 10px 28px;
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      letter-spacing: .2px;
      transition: background .15s ease, transform .1s ease, box-shadow .15s ease;
      box-shadow: 0 1px 3px rgba(37,99,235,.35);
      min-height: 42px;
      min-width: 110px;
    }
    button#analyzeBtn:hover:not(:disabled) {
      background: #1d4ed8;
      box-shadow: 0 3px 10px rgba(37,99,235,.4);
      transform: translateY(-1px);
    }
    button#analyzeBtn:active:not(:disabled) {
      transform: translateY(0);
      box-shadow: 0 1px 3px rgba(37,99,235,.35);
    }
    button#analyzeBtn:disabled {
      background: #93b4e8;
      box-shadow: none;
      cursor: default;
      transform: none;
    }

    /* ── Status / error line ──────────────────────────────────────────────── */
    #status { min-height: 22px; color: #57606a; font-size: 13px; }
    .error-msg { color: #b91c1c; }

    /* ── Results area ─────────────────────────────────────────────────────── */
    #results { margin-top: 28px; }

    /* Fade-in animation for panels appearing */
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .panel {
      background: #fff;
      border: 1px solid #e2e5ea;
      border-radius: 12px;
      padding: 22px 26px;
      margin-bottom: 20px;
      box-shadow: 0 1px 4px rgba(0,0,0,.05), 0 4px 14px rgba(0,0,0,.04);
      animation: fadeUp .3s ease both;
    }
    .panel h2 {
      margin: 0 0 16px;
      font-size: 14px;
      font-weight: 700;
      color: #374151;
      text-transform: uppercase;
      letter-spacing: .5px;
      border-bottom: 1px solid #e5e7eb;
      padding-bottom: 10px;
    }

    /* ── Suspects table ───────────────────────────────────────────────────── */
    .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 500px; }
    th {
      text-align: left;
      padding: 8px 12px;
      background: #f8f9fb;
      border-bottom: 1px solid #e5e7eb;
      font-size: 11px;
      font-weight: 700;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: .4px;
    }
    td { padding: 9px 12px; border-bottom: 1px solid #f0f2f4; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tbody tr { transition: background .12s ease; }
    tbody tr:hover { background: #f9fafb; }
    .rank { font-weight: 700; color: #9ca3af; width: 36px; }
    .score-badge {
      display: inline-block;
      padding: 2px 9px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
    }
    .score-high  { background: #fee2e2; color: #b91c1c; }
    .score-med   { background: #fef3c7; color: #92400e; }
    .score-low   { background: #dbeafe; color: #1d4ed8; }
    .file-name   { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 12px; color: #2563eb; word-break: break-all; }
    .reason      { color: #6b7280; font-size: 12px; }

    /* ── Mermaid graph ────────────────────────────────────────────────────── */
    #mermaid-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }

    /* ── AI Diagnosis panel ───────────────────────────────────────────────── */
    #ai-diagnosis { margin-bottom: 20px; }
    .diag-section { margin-bottom: 16px; }
    .diag-section:last-child { margin-bottom: 0; }
    .diag-section h3 {
      font-size: 11px;
      font-weight: 700;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: .5px;
      margin: 0 0 8px;
    }
    .diag-content {
      background: #f8f9fb;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 14px 16px;
      font-size: 13px;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.65;
      transition: opacity .2s ease;
    }
    .diag-loading { color: #57606a; font-size: 13px; }
    .diag-error   { color: #b91c1c; font-size: 13px; }

    /* ── Spinner ──────────────────────────────────────────────────────────── */
    .spinner {
      display: inline-block;
      width: 15px; height: 15px;
      border: 2px solid #d1d5db;
      border-top-color: #3b82d4;
      border-radius: 50%;
      animation: spin .7s linear infinite;
      vertical-align: middle;
      margin-right: 8px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Skeleton / shimmer ───────────────────────────────────────────────── */
    @keyframes shimmer {
      0%   { background-position: -600px 0; }
      100% { background-position:  600px 0; }
    }
    .skeleton-line {
      display: inline-block;
      border-radius: 4px;
      background: linear-gradient(90deg, #e9eaec 25%, #f3f4f6 50%, #e9eaec 75%);
      background-size: 600px 100%;
      animation: shimmer 1.4s ease-in-out infinite;
    }
    .sk-rank  { width: 18px;  height: 12px; }
    .sk-file  { width: 220px; height: 12px; }
    .sk-score { width: 52px;  height: 18px; border-radius: 10px; }
    .sk-reason-a { width: 180px; height: 11px; margin-bottom: 4px; }
    .sk-reason-b { width: 120px; height: 11px; }

    /* ── Responsive ───────────────────────────────────────────────────────── */
    @media (max-width: 600px) {
      .nav-bar { padding: 0 16px; }
      .hero { padding: 36px 20px 32px; }
      main { margin: 20px auto; padding: 0 14px; }
      .form-card { padding: 20px 16px; }
      .panel { padding: 18px 16px; }
      .form-footer { flex-direction: column; align-items: stretch; }
      button#analyzeBtn { width: 100%; justify-content: center; }
      .sk-file { width: 140px; }
    }
  </style>
</head>
<body>
  <!-- Nav bar -->
  <div class="nav-bar">
    <div class="nav-logo">🐛</div>
    Bug Tracer
  </div>

  <!-- Hero -->
  <div class="hero">
    <h1>Trace Your <span>Codebase</span></h1>
    <p>Point Bug Tracer at any local repository, describe what went wrong, and it surfaces the files most likely responsible — ranked by relevance.</p>
    <div class="lang-badge">
      Supports:&nbsp;<span>JavaScript</span>&nbsp;·&nbsp;<span>TypeScript</span>&nbsp;·&nbsp;<span>Python</span>
    </div>
  </div>

  <main>
    <!-- Input form -->
    <div class="form-card">
      <div class="field">
        <label for="repoPath">Repository path</label>
        <input type="text" id="repoPath" placeholder="/absolute/path/to/your/repo" spellcheck="false" autocomplete="off">
      </div>
      <div class="field">
        <label for="bugDesc">Bug description</label>
        <textarea id="bugDesc" placeholder="Describe the bug — e.g. &quot;payments fail when user has no saved card&quot; or &quot;login throws 500 on empty password&quot;"></textarea>
      </div>
      <div class="form-footer">
        <button id="analyzeBtn" onclick="analyze()">Analyze</button>
        <div id="status"></div>
      </div>
    </div>
    <div id="results"></div>
  </main>

  <script>
    // The Mermaid CDN script loads with defer, so it is guaranteed to have
    // executed before DOMContentLoaded fires and before any inline onclick
    // handler runs.  Guard the initialize call in case the CDN is unreachable.
    if (typeof mermaid !== 'undefined') {
      mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
    }

    function skRow(i) {
      return '<tr>'
        + '<td class="rank"><span class="skeleton-line sk-rank"></span></td>'
        + '<td><span class="skeleton-line sk-file"></span></td>'
        + '<td><span class="skeleton-line sk-score"></span></td>'
        + '<td><span class="skeleton-line sk-reason-a"></span><br><span class="skeleton-line sk-reason-b"></span></td>'
        + '</tr>';
    }

    function buildSkeleton() {
      let rows = '';
      for (let i = 0; i < 6; i++) rows += skRow(i);
      return '<div class="panel">'
        + '<h2>Suspect Files</h2>'
        + '<div class="table-scroll"><table>'
        + '<thead><tr><th class="rank">#</th><th>File</th><th>Score</th><th>Reason</th></tr></thead>'
        + '<tbody>' + rows + '</tbody>'
        + '</table></div>'
        + '</div>';
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
      status.innerHTML = '';
      out.innerHTML = buildSkeleton();

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
        out.innerHTML = '';
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
        html += '<div class="panel"><h2>Suspect Files</h2><p style="color:#6b7280">No matching files found. Try a more descriptive bug report.</p></div>';
      } else {
        html += '<div class="panel"><h2>Suspect Files</h2><div class="table-scroll"><table>';
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
        html += '</tbody></table></div></div>';
      }

      // ── AI Diagnosis panel ──────────────────────────────────────────────────
      html += '<div class="panel" id="ai-diagnosis"><h2>AI Diagnosis</h2><div id="diag-inner"><div class="diag-loading"><span class="spinner"></span>Running AI diagnosis\u2026</div></div></div>';

      // ── Mermaid graph panel ─────────────────────────────────────────────────
      const graphSubtitle = graphTrimmed
        ? '<p style="color:#6b7280;font-size:12px;margin:0 0 12px">Showing top 30 most-connected nodes of ' + rawNodeCount + ' total (graph trimmed for readability).</p>'
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
