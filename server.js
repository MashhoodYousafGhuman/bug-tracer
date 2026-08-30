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
    return res.status(400).json({
      error: 'Codebase not found at that path. Please double-check the path is correct and try again.',
      debugPath: absRepoPath,
    });
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
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js" defer><\/script>
  <style>
    /* ── Reset & base ───────────────────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, "Segoe UI", Inter, system-ui, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      background: #1c1814;
      color: #e8e0d5;
      height: 100vh;
      overflow: hidden;
    }

    /* ── App shell: sidebar + main ──────────────────────────────────────── */
    .app-shell {
      display: flex;
      height: 100vh;
      overflow: hidden;
    }

    /* ── Sidebar ────────────────────────────────────────────────────────── */
    .sidebar {
      width: 260px;
      flex-shrink: 0;
      background: #161310;
      border-right: 1px solid #2e2720;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      transition: transform .25s ease;
      z-index: 100;
    }
    .sidebar-header {
      padding: 20px 18px 16px;
      border-bottom: 1px solid #2e2720;
      flex-shrink: 0;
    }
    .sidebar-brand {
      display: flex;
      align-items: center;
      gap: 9px;
      margin-bottom: 14px;
    }
    .brand-logo {
      width: 28px; height: 28px;
      background: #c2693e;
      border-radius: 7px;
      display: flex; align-items: center; justify-content: center;
      font-size: 15px;
      flex-shrink: 0;
    }
    .brand-name {
      font-size: 15px;
      font-weight: 700;
      color: #f0e8de;
      letter-spacing: -.1px;
    }
    .new-chat-btn {
      width: 100%;
      padding: 8px 14px;
      background: transparent;
      border: 1px solid #3a3028;
      border-radius: 8px;
      color: #c9bfb3;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      text-align: left;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: background .15s ease, border-color .15s ease, color .15s ease;
      letter-spacing: .1px;
    }
    .new-chat-btn:hover {
      background: #231f1a;
      border-color: #4a3f35;
      color: #e8ddd5;
    }
    .new-chat-plus {
      font-size: 16px;
      line-height: 1;
      color: #c2693e;
      font-weight: 400;
    }
    .sidebar-history-label {
      padding: 14px 18px 6px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .8px;
      color: #5a5248;
      flex-shrink: 0;
    }
    .sidebar-history {
      flex: 1;
      overflow-y: auto;
      padding: 0 8px 4px;
    }
    .sidebar-clear-btn {
      flex-shrink: 0;
      padding: 8px 18px 12px;
      text-align: center;
    }
    .sidebar-clear-btn a {
      font-size: 11px;
      color: #3d3530;
      text-decoration: none;
      cursor: pointer;
      transition: color .15s ease;
      letter-spacing: .1px;
    }
    .sidebar-clear-btn a:hover {
      color: #e07060;
    }
    .sidebar-history::-webkit-scrollbar { width: 4px; }
    .sidebar-history::-webkit-scrollbar-track { background: transparent; }
    .sidebar-history::-webkit-scrollbar-thumb { background: #2e2720; border-radius: 2px; }
    .session-item {
      padding: 9px 12px;
      border-radius: 7px;
      cursor: pointer;
      font-size: 13px;
      color: #9b9089;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: background .12s ease, color .12s ease;
      margin-bottom: 2px;
      border: 1px solid transparent;
    }
    .session-item:hover {
      background: #1f1b17;
      color: #d4c9be;
    }
    .session-item.active {
      background: #271f18;
      border-color: #3d3028;
      color: #e8ddd5;
      font-weight: 500;
    }
    .sidebar-empty {
      padding: 12px;
      font-size: 12px;
      color: #4a4038;
      text-align: center;
      line-height: 1.5;
    }

    /* ── Main content area ──────────────────────────────────────────────── */
    .main-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: #1c1814;
    }

    /* ── Top bar (mobile hamburger + title) ─────────────────────────────── */
    .top-bar {
      display: none;
      align-items: center;
      gap: 12px;
      padding: 0 18px;
      height: 50px;
      border-bottom: 1px solid #2e2720;
      flex-shrink: 0;
      background: #161310;
    }
    .hamburger-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 6px;
      color: #9b9089;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .hamburger-btn span {
      display: block;
      width: 20px; height: 2px;
      background: currentColor;
      border-radius: 1px;
      transition: opacity .2s ease;
    }
    .top-bar-title {
      font-size: 14px;
      font-weight: 700;
      color: #d4c9be;
    }

    /* ── Scrollable content ─────────────────────────────────────────────── */
    .content-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 36px 28px 48px;
    }
    .content-scroll::-webkit-scrollbar { width: 6px; }
    .content-scroll::-webkit-scrollbar-track { background: transparent; }
    .content-scroll::-webkit-scrollbar-thumb { background: #2e2720; border-radius: 3px; }
    .content-inner {
      max-width: 820px;
      margin: 0 auto;
    }

    /* ── Page title area ────────────────────────────────────────────────── */
    .page-title {
      margin-bottom: 28px;
    }
    .page-title h1 {
      font-size: clamp(20px, 3vw, 26px);
      font-weight: 800;
      color: #f0e8de;
      margin: 0 0 6px;
      letter-spacing: -.4px;
      line-height: 1.2;
    }
    .page-title h1 span { color: #c2693e; }
    .page-title p {
      margin: 0;
      color: #7a6e65;
      font-size: 13.5px;
      line-height: 1.55;
    }
    .lang-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(194,105,62,.08);
      border: 1px solid rgba(194,105,62,.2);
      border-radius: 20px;
      padding: 4px 12px;
      font-size: 11px;
      color: #9b8070;
      letter-spacing: .2px;
      margin-top: 10px;
    }
    .lang-badge span { color: #c2693e; font-weight: 600; }

    /* ── Input form card ────────────────────────────────────────────────── */
    .form-card {
      background: #201c18;
      border: 1px solid #2e2720;
      border-radius: 12px;
      padding: 24px 24px 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,.3);
      margin-bottom: 8px;
    }
    label {
      display: block;
      font-weight: 600;
      font-size: 12px;
      color: #9b9089;
      margin-bottom: 6px;
      letter-spacing: .3px;
      text-transform: uppercase;
    }
    .field { margin-bottom: 16px; }
    .field:last-of-type { margin-bottom: 0; }
    input[type="text"], textarea {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid #2e2720;
      border-radius: 8px;
      font-family: inherit;
      font-size: 14px;
      background: #161310;
      color: #e8e0d5;
      outline: none;
      transition: border-color .15s ease, box-shadow .15s ease;
    }
    input[type="text"]::placeholder, textarea::placeholder { color: #4a4038; }
    input[type="text"]:focus, textarea:focus {
      border-color: #c2693e;
      box-shadow: 0 0 0 3px rgba(194,105,62,.15);
    }
    textarea { min-height: 96px; resize: vertical; }

    /* ── Form footer row ────────────────────────────────────────────────── */
    .form-footer {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-top: 18px;
      flex-wrap: wrap;
    }
    button#analyzeBtn {
      padding: 10px 26px;
      background: #c2693e;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 13.5px;
      font-weight: 700;
      cursor: pointer;
      letter-spacing: .2px;
      transition: background .15s ease, transform .1s ease, box-shadow .15s ease;
      box-shadow: 0 1px 4px rgba(194,105,62,.4);
      min-height: 40px;
      min-width: 110px;
    }
    button#analyzeBtn:hover:not(:disabled) {
      background: #b05c34;
      box-shadow: 0 3px 10px rgba(194,105,62,.45);
      transform: translateY(-1px);
    }
    button#analyzeBtn:active:not(:disabled) {
      transform: translateY(0);
      box-shadow: 0 1px 4px rgba(194,105,62,.4);
    }
    button#analyzeBtn:disabled {
      background: #6b3f28;
      box-shadow: none;
      cursor: default;
      transform: none;
      color: #a07060;
    }

    /* ── Status / error line ────────────────────────────────────────────── */
    #status { min-height: 22px; color: #7a6e65; font-size: 13px; }
    .error-msg { color: #e07060; }

    /* ── Results area ───────────────────────────────────────────────────── */
    #results { margin-top: 24px; }

    /* Fade-in animation for panels appearing */
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .panel {
      background: #201c18;
      border: 1px solid #2e2720;
      border-radius: 12px;
      padding: 20px 22px;
      margin-bottom: 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,.25);
      animation: fadeUp .3s ease both;
    }
    .panel h2 {
      margin: 0 0 14px;
      font-size: 11px;
      font-weight: 700;
      color: #7a6e65;
      text-transform: uppercase;
      letter-spacing: .7px;
      border-bottom: 1px solid #2e2720;
      padding-bottom: 10px;
    }

    /* ── Suspects table ─────────────────────────────────────────────────── */
    .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 500px; }
    th {
      text-align: left;
      padding: 8px 12px;
      background: #1a1713;
      border-bottom: 1px solid #2e2720;
      font-size: 10px;
      font-weight: 700;
      color: #5a5248;
      text-transform: uppercase;
      letter-spacing: .5px;
    }
    td { padding: 9px 12px; border-bottom: 1px solid #252119; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tbody tr { transition: background .12s ease; }
    tbody tr:hover { background: #251f1a; }
    .rank { font-weight: 700; color: #5a5248; width: 36px; }
    .score-badge {
      display: inline-block;
      padding: 2px 9px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
    }
    .score-high  { background: rgba(224,80,70,.15); color: #e87060; }
    .score-med   { background: rgba(194,105,62,.18); color: #d4845a; }
    .score-low   { background: rgba(120,140,180,.12); color: #8090b0; }
    .file-name   { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 12px; color: #c2693e; word-break: break-all; }
    .reason      { color: #6b6058; font-size: 12px; }

    /* ── Dependency graph button ────────────────────────────────────────── */
    .graph-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 20px;
      background: transparent;
      border: 1px solid #3a3028;
      border-radius: 8px;
      color: #c9bfb3;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      letter-spacing: .1px;
      transition: background .15s ease, border-color .15s ease, color .15s ease;
    }
    .graph-btn:hover {
      background: #271f18;
      border-color: #c2693e;
      color: #f0e8de;
    }
    .graph-btn-icon { font-size: 15px; }

    /* ── Graph modal overlay ────────────────────────────────────────────── */
    .graph-modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.78);
      z-index: 500;
      align-items: center;
      justify-content: center;
    }
    .graph-modal-overlay.open { display: flex; }
    .graph-modal {
      position: relative;
      background: #1a1713;
      border: 1px solid #3a3028;
      border-radius: 14px;
      width: calc(100vw - 48px);
      height: calc(100vh - 48px);
      max-width: 1400px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .graph-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 18px 12px;
      border-bottom: 1px solid #2e2720;
      flex-shrink: 0;
      gap: 12px;
    }
    .graph-modal-title {
      font-size: 11px;
      font-weight: 700;
      color: #7a6e65;
      text-transform: uppercase;
      letter-spacing: .7px;
    }
    .graph-modal-subtitle {
      font-size: 12px;
      color: #5a5248;
      margin-left: 4px;
    }
    .graph-modal-controls {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .graph-ctrl-btn {
      width: 32px; height: 32px;
      background: #252119;
      border: 1px solid #3a3028;
      border-radius: 7px;
      color: #c9bfb3;
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background .12s ease, border-color .12s ease, color .12s ease;
      flex-shrink: 0;
    }
    .graph-ctrl-btn:hover { background: #302820; border-color: #c2693e; color: #f0e8de; }
    .graph-reset-btn {
      padding: 0 12px;
      width: auto;
      font-size: 12px;
      font-weight: 600;
    }
    .graph-close-btn {
      font-size: 18px;
      margin-left: 4px;
    }
    .graph-modal-body {
      flex: 1;
      overflow: hidden;
      position: relative;
      cursor: grab;
    }
    .graph-modal-body.dragging { cursor: grabbing; }
    .graph-pan-container {
      position: absolute;
      top: 0; left: 0;
      transform-origin: 0 0;
      /* transform set via JS */
    }
    #modal-mermaid-graph svg {
      display: block;
      max-width: none !important;
    }
    #modal-mermaid-status {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #5a5248;
      font-size: 13px;
      pointer-events: none;
    }

    /* ── AI Diagnosis panel ─────────────────────────────────────────────── */
    #ai-diagnosis { margin-bottom: 16px; }
    .diag-section { margin-bottom: 16px; }
    .diag-section:last-child { margin-bottom: 0; }
    .diag-section h3 {
      font-size: 10px;
      font-weight: 700;
      color: #5a5248;
      text-transform: uppercase;
      letter-spacing: .6px;
      margin: 0 0 8px;
    }
    .diag-content {
      background: #1a1713;
      border: 1px solid #2e2720;
      border-radius: 8px;
      padding: 14px 16px;
      font-size: 13px;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.65;
      color: #c9bfb3;
      transition: opacity .2s ease;
    }
    .diag-loading { color: #7a6e65; font-size: 13px; }
    .diag-error   { color: #e07060; font-size: 13px; }

    /* ── Spinner ────────────────────────────────────────────────────────── */
    .spinner {
      display: inline-block;
      width: 15px; height: 15px;
      border: 2px solid #2e2720;
      border-top-color: #c2693e;
      border-radius: 50%;
      animation: spin .7s linear infinite;
      vertical-align: middle;
      margin-right: 8px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Skeleton / shimmer ─────────────────────────────────────────────── */
    @keyframes shimmer {
      0%   { background-position: -600px 0; }
      100% { background-position:  600px 0; }
    }
    .skeleton-line {
      display: inline-block;
      border-radius: 4px;
      background: linear-gradient(90deg, #252119 25%, #302a22 50%, #252119 75%);
      background-size: 600px 100%;
      animation: shimmer 1.4s ease-in-out infinite;
    }
    .sk-rank  { width: 18px;  height: 12px; }
    .sk-file  { width: 220px; height: 12px; }
    .sk-score { width: 52px;  height: 18px; border-radius: 10px; }
    .sk-reason-a { width: 180px; height: 11px; margin-bottom: 4px; }
    .sk-reason-b { width: 120px; height: 11px; }

    /* ── Overlay (mobile sidebar backdrop) ─────────────────────────────── */
    .sidebar-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.55);
      z-index: 99;
    }
    .sidebar-overlay.visible { display: block; }

    /* ── Responsive (mobile) ────────────────────────────────────────────── */
    @media (max-width: 700px) {
      body { overflow: hidden; }
      .top-bar { display: flex; }
      .sidebar {
        position: fixed;
        top: 0; left: 0; bottom: 0;
        transform: translateX(-100%);
      }
      .sidebar.open { transform: translateX(0); }
      .content-scroll { padding: 20px 16px 40px; }
      .panel { padding: 16px 14px; }
      .form-card { padding: 18px 14px; }
      .form-footer { flex-direction: column; align-items: stretch; }
      button#analyzeBtn { width: 100%; }
      .sk-file { width: 140px; }
      .page-title h1 { font-size: 20px; }
    }
  </style>
</head>
<body>

  <!-- Mobile sidebar overlay -->
  <div class="sidebar-overlay" id="sidebarOverlay" onclick="closeSidebar()"></div>

  <div class="app-shell">

    <!-- ── Sidebar ─────────────────────────────────────────────────────── -->
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-brand">
          <div class="brand-logo">🐛</div>
          <span class="brand-name">Bug Tracer</span>
        </div>
        <button class="new-chat-btn" onclick="newChat()">
          <span class="new-chat-plus">+</span> New Chat
        </button>
      </div>
      <div class="sidebar-history-label">History</div>
      <div class="sidebar-history" id="sessionList">
        <div class="sidebar-empty" id="noSessions">No sessions yet.<br>Run an analysis to start.</div>
      </div>
      <div class="sidebar-clear-btn">
        <a onclick="clearHistory()">Clear History</a>
      </div>
    </aside>

    <!-- ── Main area ───────────────────────────────────────────────────── -->
    <div class="main-area">

      <!-- Top bar (mobile only) -->
      <div class="top-bar">
        <button class="hamburger-btn" onclick="openSidebar()" aria-label="Open sidebar">
          <span></span><span></span><span></span>
        </button>
        <span class="top-bar-title">Bug Tracer</span>
      </div>

      <!-- Scrollable content -->
      <div class="content-scroll">
        <div class="content-inner">

          <!-- Page title -->
          <div class="page-title">
            <h1>Trace Your <span>Codebase</span></h1>
            <p>Point Bug Tracer at any local repository, describe what went wrong, and it surfaces the files most likely responsible — ranked by relevance.</p>
            <div class="lang-badge">
              Supports:&nbsp;<span>JavaScript</span>&nbsp;·&nbsp;<span>TypeScript</span>&nbsp;·&nbsp;<span>Python</span>
            </div>
          </div>

          <!-- Input form -->
          <div class="form-card">
            <div class="field">
              <label for="repoPath">Repository path</label>
              <input type="text" id="repoPath" placeholder="/absolute/path/to/your/repo" spellcheck="false" autocomplete="off">
            </div>
            <div class="field">
              <label for="bugDesc">Bug description</label>
              <textarea id="bugDesc" placeholder="Describe the bug — e.g. &quot;payments fail when user has no saved card&quot; or &quot;login throws 500 on empty password&quot;"></textarea>
              <p style="margin:4px 0 0;font-size:11px;color:#4a4038;line-height:1.4;">Tip: describe symptoms and expected behavior clearly for the most accurate results (e.g. &ldquo;seat count shows 1 when flight is full, should show 0&rdquo;)</p>
            </div>
            <div class="form-footer">
              <button id="analyzeBtn" onclick="analyze()">Analyze</button>
              <div id="status"></div>
            </div>
          </div>

          <div id="results"></div>

        </div>
      </div>
    </div>
  </div>

  <!-- ── Dependency graph full-screen modal ──────────────────────────────── -->
  <div class="graph-modal-overlay" id="graph-modal-overlay" onclick="closeGraphModal(event)">
    <div class="graph-modal" onclick="event.stopPropagation()">
      <div class="graph-modal-header">
        <div>
          <span class="graph-modal-title">Dependency Graph</span>
          <span class="graph-modal-subtitle" id="graph-modal-subtitle"></span>
        </div>
        <div class="graph-modal-controls">
          <button class="graph-ctrl-btn" onclick="_zoomBy(0.2)" title="Zoom in">+</button>
          <button class="graph-ctrl-btn" onclick="_zoomBy(-0.2)" title="Zoom out">&minus;</button>
          <button class="graph-ctrl-btn graph-reset-btn" onclick="_resetGraphView()" title="Reset view">Reset view</button>
          <button class="graph-ctrl-btn graph-close-btn" onclick="closeGraphModal()" title="Close">&times;</button>
        </div>
      </div>
      <div class="graph-modal-body" id="graph-modal-body">
        <div class="graph-pan-container" id="graph-pan-container">
          <div id="modal-mermaid-graph"></div>
        </div>
        <div id="modal-mermaid-status"></div>
      </div>
    </div>
  </div>

  <script>
    // ── Mermaid init ────────────────────────────────────────────────────────
    // The Mermaid CDN script loads with defer, so it is guaranteed to have
    // executed before DOMContentLoaded fires and before any inline onclick
    // handler runs.  Guard the initialize call in case the CDN is unreachable.
    if (typeof mermaid !== 'undefined') {
      mermaid.initialize({ startOnLoad: false, theme: 'dark' });
    }

    // ── Session store ───────────────────────────────────────────────────────
    var sessions = [];
    var activeSessionId = null;

    // ── localStorage helpers ─────────────────────────────────────────────────
    var _STORAGE_KEY = 'bugTracerSessions';

    function saveSessionsToStorage() {
      try {
        localStorage.setItem(_STORAGE_KEY, JSON.stringify(sessions));
      } catch (e) {
        // Storage full or unavailable (e.g. private browsing) — fail silently.
      }
    }

    function loadSessionsFromStorage() {
      try {
        var raw = localStorage.getItem(_STORAGE_KEY);
        if (!raw) return;
        var stored = JSON.parse(raw);
        if (!Array.isArray(stored) || stored.length === 0) return;
        sessions = stored;
        renderSessionList();
        // Do NOT auto-select any session or render results — sidebar only.
      } catch (e) {
        // Corrupt data or unavailable storage — start fresh.
      }
    }

    function sessionLabel(bugDescription) {
      var s = (bugDescription || '').trim();
      if (!s) return 'Untitled';
      return s.length > 40 ? s.slice(0, 40) + '…' : s;
    }

    function renderSessionList() {
      var list = document.getElementById('sessionList');
      var empty = document.getElementById('noSessions');
      if (sessions.length === 0) {
        list.innerHTML = '<div class="sidebar-empty" id="noSessions">No sessions yet.<br>Run an analysis to start.</div>';
        return;
      }
      var html = '';
      // Show most-recent first
      for (var i = sessions.length - 1; i >= 0; i--) {
        var s = sessions[i];
        var active = s.id === activeSessionId ? ' active' : '';
        html += '<div class="session-item' + active + '" onclick="loadSession(' + s.id + ')">' + escHtml(sessionLabel(s.bugDescription)) + '</div>';
      }
      list.innerHTML = html;
    }

    function pushSession(repoPath, bugDescription, suspects, mermaidSrc, graphTrimmed, rawNodeCount) {
      var id = Date.now();
      var session = { id: id, repoPath: repoPath, bugDescription: bugDescription, suspects: suspects, mermaid: mermaidSrc, graphTrimmed: graphTrimmed, rawNodeCount: rawNodeCount, diagnosis: null };
      sessions.push(session);
      activeSessionId = id;
      renderSessionList();
      saveSessionsToStorage();
      return session;
    }

    function loadSession(id) {
      var session = null;
      for (var i = 0; i < sessions.length; i++) {
        if (sessions[i].id === id) { session = sessions[i]; break; }
      }
      if (!session) return;
      activeSessionId = id;
      renderSessionList();
      closeSidebar();
      // Re-display stored results without any API call
      renderResults(session.suspects, session.mermaid, session.graphTrimmed, session.rawNodeCount, session);
    }

    // ── Sidebar controls ────────────────────────────────────────────────────
    function openSidebar() {
      document.getElementById('sidebar').classList.add('open');
      document.getElementById('sidebarOverlay').classList.add('visible');
    }
    function closeSidebar() {
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebarOverlay').classList.remove('visible');
    }

    // ── New Chat ────────────────────────────────────────────────────────────
    function newChat() {
      activeSessionId = null;
      document.getElementById('repoPath').value = '';
      document.getElementById('bugDesc').value = '';
      document.getElementById('results').innerHTML = '';
      document.getElementById('status').innerHTML = '';
      renderSessionList();
      closeSidebar();
    }

    // ── Skeleton loading state ───────────────────────────────────────────────
    function skRow(i) {
      return '<tr>'
        + '<td class="rank"><span class="skeleton-line sk-rank"></span></td>'
        + '<td><span class="skeleton-line sk-file"></span></td>'
        + '<td><span class="skeleton-line sk-score"></span></td>'
        + '<td><span class="skeleton-line sk-reason-a"></span><br><span class="skeleton-line sk-reason-b"></span></td>'
        + '</tr>';
    }

    function buildSkeleton() {
      var rows = '';
      for (var i = 0; i < 6; i++) rows += skRow(i);
      return '<div class="panel">'
        + '<h2>Suspect Files</h2>'
        + '<div class="table-scroll"><table>'
        + '<thead><tr><th class="rank">#</th><th>File</th><th>Score</th><th>Reason</th></tr></thead>'
        + '<tbody>' + rows + '</tbody>'
        + '</table></div>'
        + '</div>';
    }

    // ── Analyze ─────────────────────────────────────────────────────────────
    async function analyze() {
      var repoPath       = document.getElementById('repoPath').value.trim();
      var bugDescription = document.getElementById('bugDesc').value.trim();
      var btn    = document.getElementById('analyzeBtn');
      var status = document.getElementById('status');
      var out    = document.getElementById('results');

      if (!repoPath || !bugDescription) {
        status.innerHTML = '<span class="error-msg">Please fill in both fields.</span>';
        return;
      }

      btn.disabled = true;
      status.innerHTML = '';
      out.innerHTML = buildSkeleton();

      try {
        var resp = await fetch('/api/analyze', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ repoPath: repoPath, bugDescription: bugDescription }),
        });
        var data = await resp.json();
        if (!resp.ok) {
          var err = new Error(data.error || resp.statusText);
          if (data.debugPath) err.debugPath = data.debugPath;
          throw err;
        }

        status.innerHTML = '';

        // Push to session store and mark active BEFORE rendering (so re-render
        // of diagnosis later can update the right session object by reference).
        var session = pushSession(repoPath, bugDescription, data.suspects, data.mermaid, data.graphTrimmed, data.rawNodeCount);

        // Clear inputs so they are ready for the next query
        document.getElementById('repoPath').value = '';
        document.getElementById('bugDesc').value = '';

        renderResults(data.suspects, data.mermaid, data.graphTrimmed, data.rawNodeCount, session);
      } catch (err) {
        out.innerHTML = '';
        if (err.debugPath) console.log('[bug-tracer] repoPath not found on disk:', err.debugPath);
        status.innerHTML = '<span class="error-msg">Error: ' + escHtml(err.message) + '</span>';
      } finally {
        btn.disabled = false;
      }
    }

    // ── Score helpers ────────────────────────────────────────────────────────
    function scoreCls(s) {
      if (s >= 0.5) return 'score-high';
      if (s >= 0.25) return 'score-med';
      return 'score-low';
    }

    // ── Render results ───────────────────────────────────────────────────────
    // session is optional (passed when we want loadDiagnosis to store results
    // back on the session object); omitted when re-displaying a stored session.
    function renderResults(suspects, mermaidSrc, graphTrimmed, rawNodeCount, session) {
      var out = document.getElementById('results');
      var html = '';

      // ── Suspects panel ────────────────────────────────────────────────────
      if (!suspects || suspects.length === 0) {
        html += '<div class="panel"><h2>Suspect Files</h2><p style="color:#5a5248">No matching files found. Try a more descriptive bug report.</p></div>';
      } else {
        html += '<div class="panel"><h2>Suspect Files</h2><div class="table-scroll"><table>';
        html += '<thead><tr><th class="rank">#</th><th>File</th><th>Score</th><th>Reason</th></tr></thead><tbody>';
        suspects.slice(0, 20).forEach(function(s, i) {
          var cls = scoreCls(s.score);
          html += '<tr>';
          html += '<td class="rank">' + (i + 1) + '</td>';
          html += '<td class="file-name">' + escHtml(s.file) + '</td>';
          html += '<td><span class="score-badge ' + cls + '">' + s.score.toFixed(3) + '</span></td>';
          html += '<td class="reason">' + escHtml(s.reason) + '</td>';
          html += '</tr>';
        });
        html += '</tbody></table></div></div>';
      }

      // ── AI Diagnosis panel ────────────────────────────────────────────────
      if (suspects && suspects.length > 0) {
        // If we are re-displaying a stored session that already has a diagnosis,
        // render it immediately without a loading spinner.
        if (session && session.diagnosis) {
          html += '<div class="panel" id="ai-diagnosis"><h2>AI Diagnosis</h2><div id="diag-inner">'
            + diagSection('Root Cause',      session.diagnosis.rootCause)
            + diagSection('Suggested Patch', session.diagnosis.suggestedPatch)
            + diagSection('Suggested Test',  session.diagnosis.suggestedTest)
            + '</div></div>';
        } else {
          html += '<div class="panel" id="ai-diagnosis"><h2>AI Diagnosis</h2><div id="diag-inner"><div class="diag-loading"><span class="spinner"></span>Running AI diagnosis\u2026</div></div></div>';
        }
      } else {
        html += '<div class="panel" id="ai-diagnosis"><h2>AI Diagnosis</h2><p style="color:#5a5248;font-size:13px;margin:0">No suspects found \u2014 try a more descriptive bug report.</p></div>';
      }

      // ── Mermaid graph panel (button → modal) ─────────────────────────────
      var graphSubtitleText = graphTrimmed
        ? 'Showing top 30 most-connected nodes of ' + rawNodeCount + ' total'
        : '';
      // Store mermaid source + subtitle on a data attribute so the modal can
      // access them without a closure leak across session loads.
      html += '<div class="panel">'
            + '<h2>Dependency Graph</h2>'
            + (graphSubtitleText ? '<p style="color:#5a5248;font-size:12px;margin:0 0 14px">' + escHtml(graphSubtitleText) + ' (graph trimmed for readability).</p>' : '')
            + '<button class="graph-btn" id="view-graph-btn" onclick="openGraphModal()">'
            + '<span class="graph-btn-icon">&#9906;</span> View Dependency Graph'
            + '</button>'
            + '</div>';

      out.innerHTML = html;

      // Store the current mermaid source so the modal renderer can pick it up.
      // Use a module-level variable so loadSession re-assignments work correctly.
      _currentMermaidSrc      = mermaidSrc || '';
      _currentGraphSubtitle   = graphSubtitleText;

      // Log the raw Mermaid source so it can be inspected in the browser console
      console.log('[bug-tracer] mermaid source:', mermaidSrc);

      // Kick off AI diagnosis only for a fresh analysis (session passed and no
      // prior diagnosis cached on it).
      if (suspects && suspects.length > 0 && session && !session.diagnosis) {
        loadDiagnosis(session.repoPath, session.bugDescription, suspects, session);
      }
    }

    // ── Load AI diagnosis ────────────────────────────────────────────────────
    async function loadDiagnosis(repoPath, bugDescription, suspects, session) {
      var diag = document.getElementById('diag-inner');
      if (!diag) return;
      try {
        var resp = await fetch('/api/diagnose', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ repoPath: repoPath, bugDescription: bugDescription, suspects: suspects.slice(0, 5) }),
        });
        var data = await resp.json();
        if (!resp.ok) throw new Error(data.error || resp.statusText);

        // Cache diagnosis on session object so it can be redisplayed without
        // another API call when the user clicks the session in the sidebar.
        if (session) {
          session.diagnosis = { rootCause: data.rootCause, suggestedPatch: data.suggestedPatch, suggestedTest: data.suggestedTest };
          saveSessionsToStorage();
        }

        // Only update the DOM if this session is still the visible one.
        var diagNow = document.getElementById('diag-inner');
        if (diagNow) {
          diagNow.innerHTML =
            diagSection('Root Cause',      data.rootCause) +
            diagSection('Suggested Patch', data.suggestedPatch) +
            diagSection('Suggested Test',  data.suggestedTest);
        }
      } catch (err) {
        var diagErr = document.getElementById('diag-inner');
        if (diagErr) {
          diagErr.innerHTML = '<div class="diag-error">AI diagnosis unavailable: ' + escHtml(err.message) + '</div>';
        }
      }
    }

    // ── Graph modal state ─────────────────────────────────────────────────────
    var _currentMermaidSrc    = '';
    var _currentGraphSubtitle = '';
    var _graphScale           = 1;
    var _graphOffsetX         = 0;
    var _graphOffsetY         = 0;
    var _graphRenderedSrc     = '';   // track what is already rendered to avoid double-render

    var _MIN_SCALE = 0.1;
    var _MAX_SCALE = 15;

    function _applyTransform() {
      var c = document.getElementById('graph-pan-container');
      if (c) c.style.transform = 'translate(' + _graphOffsetX + 'px,' + _graphOffsetY + 'px) scale(' + _graphScale + ')';
    }

    function openGraphModal() {
      var overlay = document.getElementById('graph-modal-overlay');
      if (!overlay) return;

      // Update subtitle text
      var sub = document.getElementById('graph-modal-subtitle');
      if (sub) sub.textContent = _currentGraphSubtitle ? _currentGraphSubtitle + ' (graph trimmed for readability).' : '';

      overlay.classList.add('open');
      document.body.style.overflow = 'hidden';

      if (_graphRenderedSrc !== _currentMermaidSrc) {
        // New source — render first, then fit once the SVG is in the DOM
        _renderModalGraph();
      } else {
        // Already rendered — fit immediately (modal body now has a layout)
        _fitGraphView();
      }
    }

    function closeGraphModal() {
      var overlay = document.getElementById('graph-modal-overlay');
      if (overlay) overlay.classList.remove('open');
      document.body.style.overflow = '';
    }

    // Compute a scale that fits the rendered SVG inside the modal body at ~90%
    // of the available area, then centre it.  Falls back to scale=1 if the SVG
    // or body dimensions are not yet available.
    function _fitGraphView() {
      var body = document.getElementById('graph-modal-body');
      var svg  = document.querySelector('#modal-mermaid-graph svg');
      if (!body || !svg) {
        _graphScale   = 1;
        _graphOffsetX = 0;
        _graphOffsetY = 0;
        _applyTransform();
        return;
      }
      var bodyW = body.clientWidth;
      var bodyH = body.clientHeight;
      // Prefer the SVG's intrinsic dimensions from its viewBox / width+height
      // attributes; fall back to the bounding rect (which may be scaled already).
      var svgW = parseFloat(svg.getAttribute('width'))  || svg.getBoundingClientRect().width  || bodyW;
      var svgH = parseFloat(svg.getAttribute('height')) || svg.getBoundingClientRect().height || bodyH;
      var fitScale = Math.min(bodyW / svgW, bodyH / svgH) * 0.9;
      fitScale = Math.min(_MAX_SCALE, Math.max(_MIN_SCALE, fitScale));
      // Centre the scaled diagram in the modal body
      var offsetX = (bodyW - svgW * fitScale) / 2;
      var offsetY = (bodyH - svgH * fitScale) / 2;
      _graphScale   = fitScale;
      _graphOffsetX = offsetX;
      _graphOffsetY = offsetY;
      _applyTransform();
    }

    function _resetGraphView() {
      _fitGraphView();
    }

    function _zoomBy(delta) {
      _graphScale = Math.min(_MAX_SCALE, Math.max(_MIN_SCALE, _graphScale + delta));
      _applyTransform();
    }

    function _renderModalGraph() {
      var el     = document.getElementById('modal-mermaid-graph');
      var status = document.getElementById('modal-mermaid-status');
      if (!el) return;

      if (!_currentMermaidSrc) {
        if (status) status.textContent = 'No graph data available.';
        return;
      }

      if (status) status.textContent = 'Rendering\u2026';
      el.innerHTML = '';

      // Use a unique id each call so Mermaid v10 never finds a stale SVG in the DOM.
      var renderId = 'mermaid-svg-' + Date.now();
      // Remove any leftover hidden SVG Mermaid may have appended to <body>
      var stale = document.getElementById(renderId);
      if (stale) stale.remove();

      if (typeof mermaid === 'undefined') {
        if (status) status.textContent = '';
        el.textContent = 'Mermaid library unavailable (CDN load failed \u2014 check network).';
        _graphRenderedSrc = '';
        return;
      }

      mermaid.render(renderId, _currentMermaidSrc).then(function(result) {
        el.innerHTML = result.svg;
        if (status) status.textContent = '';
        _graphRenderedSrc = _currentMermaidSrc;
        // Fit the newly rendered SVG into the visible modal area
        _fitGraphView();
      }).catch(function(e) {
        // Mermaid v10 sometimes throws a plain string, not an Error object.
        var msg = (e instanceof Error) ? e.message : String(e);
        console.error('[bug-tracer] mermaid render error (full):', e);
        console.error('[bug-tracer] mermaid source that failed:\\n', _currentMermaidSrc);
        if (status) status.textContent = '';
        el.textContent = 'Graph render error: ' + msg;
        _graphRenderedSrc = '';
      });
    }

    // ── Graph modal pan (drag) ────────────────────────────────────────────────
    (function() {
      var dragging = false;
      var startX = 0, startY = 0;
      var startOffX = 0, startOffY = 0;

      function onMouseDown(e) {
        if (e.button !== 0) return;
        dragging = true;
        startX = e.clientX; startY = e.clientY;
        startOffX = _graphOffsetX; startOffY = _graphOffsetY;
        var body = document.getElementById('graph-modal-body');
        if (body) body.classList.add('dragging');
        e.preventDefault();
      }
      function onMouseMove(e) {
        if (!dragging) return;
        _graphOffsetX = startOffX + (e.clientX - startX);
        _graphOffsetY = startOffY + (e.clientY - startY);
        _applyTransform();
      }
      function onMouseUp() {
        if (!dragging) return;
        dragging = false;
        var body = document.getElementById('graph-modal-body');
        if (body) body.classList.remove('dragging');
      }
      // Restore sessions from localStorage before anything else.
      document.addEventListener('DOMContentLoaded', function() {
        loadSessionsFromStorage();
      });

      // Attach once after DOM is ready
      document.addEventListener('DOMContentLoaded', function() {
        var body = document.getElementById('graph-modal-body');
        if (!body) return;
        body.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        // Mouse-wheel zoom (zoom toward the centre of the viewport for simplicity)
        body.addEventListener('wheel', function(e) {
          e.preventDefault();
          var delta = e.deltaY < 0 ? 0.1 : -0.1;
          _zoomBy(delta);
        }, { passive: false });
      });
    })();

    // ── Clear history ────────────────────────────────────────────────────────
    function clearHistory() {
      if (!confirm('Clear all session history? This cannot be undone.')) return;
      sessions = [];
      activeSessionId = null;
      try { localStorage.removeItem(_STORAGE_KEY); } catch (e) { /* unavailable — ignore */ }
      renderSessionList();
      document.getElementById('results').innerHTML = '';
      document.getElementById('status').innerHTML = '';
    }

    // ── Helpers ──────────────────────────────────────────────────────────────
    function diagSection(heading, text) {
      return '<div class="diag-section"><h3>' + escHtml(heading) + '</h3>'
           + '<div class="diag-content">' + escHtml(text || '(no output)') + '</div></div>';
    }

    function escHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
  <\/script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Bug Tracer running at http://localhost:${PORT}`);
});
