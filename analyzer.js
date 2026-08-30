/**
 * analyzer.js — Pluggable import/dependency analyzer
 *
 * Interface:
 *   extractImports(fileContent: string, filePath: string): string[]
 *   Returns a list of raw import specifiers found in the file.
 *
 * Adapters:
 *   jsAdapter   — handles .js / .ts / .jsx / .tsx (regex for ES import + require)
 *   pyAdapter   — handles .py (regex for `import X` and `from X import Y`)
 *
 * Main exports:
 *   scanRepo(repoPath: string): string
 *     Walks the repo and returns a Mermaid flowchart string.
 *
 *   scanRepoGraph(repoPath: string): RepoGraph
 *     Same walk, but returns raw graph data for further analysis.
 *     RepoGraph = { files: Map<relPath, FileInfo>, fanIn: Map<relPath, number> }
 *     FileInfo  = { content: string, imports: string[], fanOut: number }
 *
 *   hotspots(repoPath: string, options?: HotspotOptions): Promise<HotspotEntry[]>
 *     Scores every file on line count, function count, fan-in and fan-out.
 *     Processes files in parallel batches (batchSize files per batch) and
 *     returns entries sorted highest-risk first.
 *     HotspotOptions = { batchSize?: number, weights?: Weights }
 *     Weights        = { lines?: number, funcs?: number, fanIn?: number, fanOut?: number }
 *     HotspotEntry   = { file, lines, funcs, fanIn, fanOut, score }
 *
 *   walkthrough(repoPath: string): string
 *     Generates a plain-English "Start Here" narrative describing what happens
 *     when the app starts.  Reads README.md, AGENTS.md, and package.json files
 *     when present; falls back to code-structure inference when they are not.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Directories to skip when walking the repo
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv']);

// ---------------------------------------------------------------------------
// Adapter: JavaScript / TypeScript
// ---------------------------------------------------------------------------

/**
 * Patterns recognised:
 *   import ... from 'specifier'
 *   import 'specifier'
 *   require('specifier')
 *   import('specifier')   (dynamic)
 */
const JS_IMPORT_PATTERNS = [
  // ES static import:  import ... from "specifier"
  /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  // CommonJS / dynamic: require("specifier") or import("specifier")
  /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * @param {string} fileContent
 * @param {string} _filePath   (unused but satisfies the interface)
 * @returns {string[]}
 */
function jsExtractImports(fileContent, _filePath) {
  const imports = new Set();
  for (const pattern of JS_IMPORT_PATTERNS) {
    // Reset lastIndex each call since patterns are module-level (shared state).
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(fileContent)) !== null) {
      imports.add(match[1]);
    }
  }
  return [...imports];
}

const jsAdapter = {
  extensions: new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs']),
  extractImports: jsExtractImports,
};

// ---------------------------------------------------------------------------
// Adapter: Python
// ---------------------------------------------------------------------------

/**
 * Patterns recognised:
 *   import X
 *   import X as Y
 *   import X, Y
 *   from X import Y
 *   from X import (Y, Z)
 *   from .relative import Y
 */
// Match "import X" on a single line (no newlines in capture group)
const PY_IMPORT_MODULE  = /^[ \t]*import\s+([\w., \t]+)/gm;
const PY_FROM_MODULE    = /^[ \t]*from\s+([\w.]+)\s+import\s+/gm;

/**
 * @param {string} fileContent
 * @param {string} _filePath
 * @returns {string[]}
 */
function pyExtractImports(fileContent, _filePath) {
  const imports = new Set();

  // "import X" / "import X, Y" / "import X as Z"
  PY_IMPORT_MODULE.lastIndex = 0;
  let match;
  while ((match = PY_IMPORT_MODULE.exec(fileContent)) !== null) {
    // match[1] may be "os, sys" or "os as operating_system"
    const parts = match[1].split(',');
    for (const part of parts) {
      const mod = part.trim().split(/\s+as\s+/)[0].trim();
      if (mod) imports.add(mod);
    }
  }

  // "from X import ..."
  PY_FROM_MODULE.lastIndex = 0;
  while ((match = PY_FROM_MODULE.exec(fileContent)) !== null) {
    const mod = match[1].trim();
    if (mod) imports.add(mod);
  }

  return [...imports];
}

const pyAdapter = {
  extensions: new Set(['.py']),
  extractImports: pyExtractImports,
};

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

const ADAPTERS = [jsAdapter, pyAdapter];

/**
 * Returns the adapter for the given file path, or null if none matches.
 * @param {string} filePath
 */
function getAdapter(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ADAPTERS.find((a) => a.extensions.has(ext)) ?? null;
}

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

/**
 * Recursively yields all file paths under `dir`, skipping SKIP_DIRS.
 * @param {string} dir
 * @returns {Generator<string>}
 */
function* walkDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip silently
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

// ---------------------------------------------------------------------------
// Mermaid helpers
// ---------------------------------------------------------------------------

/**
 * Sanitises a string so it can be used as a Mermaid node identifier.
 * Replaces characters that would break Mermaid syntax with underscores.
 * @param {string} label
 * @returns {string}
 */
function toMermaidId(label) {
  return label.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Wraps a label in Mermaid node syntax: id["label"]
 * @param {string} label
 * @returns {string}
 */
function mermaidNode(label) {
  const id = toMermaidId(label);
  if (id === label) return id;
  // Escape any double-quotes inside the display label so Mermaid syntax stays valid
  const safeLabel = label.replace(/"/g, '#quot;');
  return `${id}["${safeLabel}"]`;
}

// ---------------------------------------------------------------------------
// Core: scanRepo
// ---------------------------------------------------------------------------

/**
 * Walks `repoPath`, uses the appropriate adapter for each recognised file,
 * and builds a dependency graph expressed as Mermaid flowchart syntax.
 *
 * @param {string} repoPath  — absolute or relative path to the repo root
 * @returns {string}         — Mermaid diagram string
 */
function scanRepo(repoPath) {
  const absRepo = path.resolve(repoPath);

  // edges: Map<sourceLabel, Set<targetLabel>>
  const edges = new Map();
  // Track all node labels so isolated files also appear in the graph
  const allNodes = new Set();

  for (const filePath of walkDir(absRepo)) {
    const adapter = getAdapter(filePath);
    if (!adapter) continue;

    // Use a repo-relative path as the node label
    const relPath = path.relative(absRepo, filePath).replace(/\\/g, '/');
    allNodes.add(relPath);

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue; // unreadable file — skip
    }

    const imports = adapter.extractImports(content, filePath);

    if (imports.length === 0) continue;

    if (!edges.has(relPath)) edges.set(relPath, new Set());

    for (const imp of imports) {
      edges.get(relPath).add(imp);
      allNodes.add(imp);
    }
  }

  // Build Mermaid output
  const lines = ['graph TD'];

  // Declare isolated nodes (no edges)
  const connectedSources = new Set(edges.keys());
  const connectedTargets = new Set([...edges.values()].flatMap((s) => [...s]));
  for (const node of allNodes) {
    if (!connectedSources.has(node) && !connectedTargets.has(node)) {
      lines.push(`  ${mermaidNode(node)}`);
    }
  }

  // Emit edges
  for (const [src, targets] of edges) {
    const srcNode = mermaidNode(src);
    for (const tgt of targets) {
      const tgtNode = mermaidNode(tgt);
      lines.push(`  ${srcNode} --> ${tgtNode}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Raw graph builder (used by both scanRepo and hotspot scoring)
// ---------------------------------------------------------------------------

/**
 * Walks `repoPath` and returns a RepoGraph:
 *   files  — Map<relPath, { content, imports, fanOut }>
 *   fanIn  — Map<relPath, number>  (how many files import this path/module)
 *
 * fanIn counts are computed over repo-relative paths only; stdlib/third-party
 * imports still contribute to fan-out of the importing file but are not
 * tracked as repo nodes.
 *
 * @param {string} repoPath
 * @returns {{ files: Map<string, {content:string, imports:string[], fanOut:number}>, fanIn: Map<string, number> }}
 */
function scanRepoGraph(repoPath) {
  const absRepo = path.resolve(repoPath);

  // relPath -> { content, imports, fanOut }
  const files = new Map();

  for (const filePath of walkDir(absRepo)) {
    const adapter = getAdapter(filePath);
    if (!adapter) continue;

    const relPath = path.relative(absRepo, filePath).replace(/\\/g, '/');

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const imports = adapter.extractImports(content, filePath);
    files.set(relPath, { content, imports, fanOut: imports.length });
  }

  // Compute fan-in: count how many repo files import each target module.
  // We do a best-effort match: if a target string ends with a known relPath
  // (after normalising path separators) it's counted as a repo-internal edge.
  const repoPathSet = new Set(files.keys());
  const fanIn = new Map();

  for (const [, info] of files) {
    for (const imp of info.imports) {
      // Normalise the import specifier:
      //   1. Convert backslashes to forward slashes.
      //   2. Strip leading "./" so that "./analyzer" matches "analyzer.js".
      const normImp = imp.replace(/\\/g, '/').replace(/^\.\//, '');
      // Exact match OR the relPath ends with the specifier
      // (handles "services/flight" matching "services/flight.py", etc.)
      for (const rp of repoPathSet) {
        const rpNoExt = rp.replace(/\.[^/.]+$/, '');
        if (rp === normImp || rpNoExt === normImp ||
            rp.endsWith('/' + normImp) || rpNoExt.endsWith('/' + normImp)) {
          fanIn.set(rp, (fanIn.get(rp) ?? 0) + 1);
        }
      }
    }
  }

  return { files, fanIn };
}

// ---------------------------------------------------------------------------
// Hotspot scoring — subagent-style parallel batch processing
// ---------------------------------------------------------------------------

/** Patterns used to count function/method definitions. */
const FUNC_PATTERNS = [
  /^\s*(?:async\s+)?function\s+\w+/gm,          // JS function declaration
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\(/gm, // anonymous export
  /(?:^|\s)(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(.*?\)\s*=>/gm, // arrow fn
  /^\s*(?:async\s+)?\w+\s*\(.*?\)\s*\{/gm,      // method shorthand
  /^\s*def\s+\w+\s*\(/gm,                        // Python def
];

/**
 * Counts function/method definitions in a file's content.
 * @param {string} content
 * @returns {number}
 */
function countFunctions(content) {
  let total = 0;
  for (const pat of FUNC_PATTERNS) {
    pat.lastIndex = 0;
    const m = content.match(pat);
    if (m) total += m.length;
  }
  return total;
}

/**
 * Scores a single batch of files.
 * Returns a Promise so multiple batches can run with Promise.all.
 *
 * @param {string[]} batch         — repo-relative file paths in this batch
 * @param {Map<string, {content:string, imports:string[], fanOut:number}>} files
 * @param {Map<string, number>}    fanIn
 * @returns {Promise<Array<{file:string, lines:number, funcs:number, fanIn:number, fanOut:number}>>}
 */
function scoreBatch(batch, files, fanIn) {
  return Promise.resolve(
    batch.map((relPath) => {
      const info = files.get(relPath);
      if (!info) return null;

      const lines  = info.content.split('\n').length;
      const funcs  = countFunctions(info.content);
      const fi     = fanIn.get(relPath) ?? 0;
      const fo     = info.fanOut;

      return { file: relPath, lines, funcs, fanIn: fi, fanOut: fo };
    }).filter(Boolean)
  );
}

/**
 * Normalises a value to [0, 1] given the max observed in the dataset.
 * Returns 0 when max === 0 to avoid division by zero.
 * @param {number} value
 * @param {number} max
 * @returns {number}
 */
function normalize(value, max) {
  return max === 0 ? 0 : value / max;
}

/**
 * Scores every source file in `repoPath` on:
 *   - line count
 *   - function/method count
 *   - import fan-in  (how many other repo files depend on this file)
 *   - import fan-out (how many modules this file imports)
 *
 * Files are processed in parallel batches. Each batch resolves independently
 * (Promise.all) so that I/O-bound work can overlap — mirroring the pattern
 * where each batch would be delegated to an independent subagent.
 *
 * @param {string} repoPath
 * @param {{ batchSize?: number, weights?: { lines?: number, funcs?: number, fanIn?: number, fanOut?: number } }} [options]
 * @returns {Promise<Array<{ file:string, lines:number, funcs:number, fanIn:number, fanOut:number, score:number }>>}
 */
async function hotspots(repoPath, options = {}) {
  const {
    batchSize = 10,
    weights: {
      lines:  wLines  = 0.25,
      funcs:  wFuncs  = 0.30,
      fanIn:  wFanIn  = 0.30,
      fanOut: wFanOut = 0.15,
    } = {},
  } = options;

  // 1. Build raw graph (synchronous — one linear scan of the repo).
  const { files, fanIn } = scanRepoGraph(repoPath);
  const allFiles = [...files.keys()];

  if (allFiles.length === 0) return [];

  // 2. Partition files into batches.
  const batches = [];
  for (let i = 0; i < allFiles.length; i += batchSize) {
    batches.push(allFiles.slice(i, i + batchSize));
  }

  // 3. Launch all batches concurrently — each batch is a self-contained
  //    unit of work, analogous to delegating to an independent subagent.
  const batchResults = await Promise.all(
    batches.map((batch) => scoreBatch(batch, files, fanIn))
  );

  // 4. Merge all batch results into a single flat list.
  const raw = batchResults.flat();

  // 5. Compute per-metric maxima for normalization.
  const maxLines  = Math.max(...raw.map((r) => r.lines),  1);
  const maxFuncs  = Math.max(...raw.map((r) => r.funcs),  1);
  const maxFanIn  = Math.max(...raw.map((r) => r.fanIn),  1);
  const maxFanOut = Math.max(...raw.map((r) => r.fanOut), 1);

  // 6. Attach composite risk score to each entry.
  const scored = raw.map((r) => ({
    ...r,
    score: +(
      wLines  * normalize(r.lines,  maxLines)  +
      wFuncs  * normalize(r.funcs,  maxFuncs)  +
      wFanIn  * normalize(r.fanIn,  maxFanIn)  +
      wFanOut * normalize(r.fanOut, maxFanOut)
    ).toFixed(4),
  }));

  // 7. Sort highest-risk first.
  scored.sort((a, b) => b.score - a.score);

  return scored;
}

// ---------------------------------------------------------------------------
// Walkthrough — plain-English "Start Here" narrative
// ---------------------------------------------------------------------------

/**
 * Reads a file and returns its content as a string, or null if unreadable.
 * @param {string} filePath
 * @returns {string|null}
 */
function tryRead(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Tries to parse a JSON file. Returns the parsed object or null.
 * @param {string} filePath
 * @returns {object|null}
 */
function tryReadJson(filePath) {
  const raw = tryRead(filePath);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Extracts a section from a Markdown string by heading text (case-insensitive).
 * Returns the text content between that heading and the next same/higher-level
 * heading, stripping Markdown syntax, or null if the heading is not found.
 *
 * @param {string} md
 * @param {string} heading  — heading text to look for, without the `#` prefix
 * @returns {string|null}
 */
function extractMdSection(md, heading) {
  const lines = md.split('\n');
  // Find the heading line
  const headRe = new RegExp(`^(#{1,4})\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  let startIdx = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headRe);
    if (m) { startIdx = i + 1; level = m[1].length; break; }
  }
  if (startIdx === -1) return null;

  // Collect lines until a heading of the same or higher level
  const stopRe = new RegExp(`^#{1,${level}}\\s`);
  const section = [];
  for (let i = startIdx; i < lines.length; i++) {
    if (stopRe.test(lines[i])) break;
    section.push(lines[i]);
  }
  return section.join('\n').trim() || null;
}

/**
 * Strips Markdown syntax (code fences, inline code, links, emphasis, headings,
 * list markers) from a string and collapses blank lines.
 * @param {string} md
 * @returns {string}
 */
function stripMarkdown(md) {
  return md
    .replace(/```[\s\S]*?```/g, '')      // fenced code blocks
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1)) // inline code → bare text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')     // [text](url) → text
    .replace(/^#{1,6}\s+/gm, '')         // headings
    .replace(/^[*\-+]\s+/gm, '• ')       // bullet markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')   // bold
    .replace(/\*([^*]+)\*/g, '$1')       // italic
    .replace(/\n{3,}/g, '\n\n')          // collapse blank lines
    .trim();
}

/**
 * Infers the app's technology stack and entry points by scanning the directory
 * structure when no README/AGENTS documentation is available.
 *
 * @param {string} absRepo
 * @returns {{ services: string[], entryPoints: string[], stack: string[] }}
 */
function inferStructure(absRepo) {
  const services = [];
  const entryPoints = [];
  const stack = [];

  // Detect top-level service directories by common entry-point files
  const ENTRY_FILES = [
    { file: 'server.py',     label: 'Python backend',    tech: 'Python/FastAPI' },
    { file: 'app.py',        label: 'Python app',        tech: 'Python' },
    { file: 'main.py',       label: 'Python main',       tech: 'Python' },
    { file: 'manage.py',     label: 'Django app',        tech: 'Python/Django' },
    { file: 'package.json',  label: 'Node.js service',   tech: 'Node.js' },
    { file: 'pom.xml',       label: 'Java/Maven service', tech: 'Java/Maven' },
    { file: 'build.gradle',  label: 'Java/Gradle service', tech: 'Java/Gradle' },
    { file: 'go.mod',        label: 'Go module',         tech: 'Go' },
    { file: 'Cargo.toml',    label: 'Rust crate',        tech: 'Rust' },
  ];

  let entries;
  try {
    entries = fs.readdirSync(absRepo, { withFileTypes: true });
  } catch {
    return { services, entryPoints, stack };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const subDir = path.join(absRepo, entry.name);
    for (const { file, label, tech } of ENTRY_FILES) {
      if (fs.existsSync(path.join(subDir, file))) {
        services.push(`${entry.name} (${label})`);
        entryPoints.push(`${entry.name}/${file}`);
        if (!stack.includes(tech)) stack.push(tech);
        break;
      }
    }
  }

  // Also check the root for entry-point files
  for (const { file, label, tech } of ENTRY_FILES) {
    if (fs.existsSync(path.join(absRepo, file))) {
      entryPoints.push(file);
      if (!stack.includes(tech)) stack.push(tech);
    }
  }

  return { services, entryPoints, stack };
}

/**
 * Generates a plain-English "Start Here" narrative for the repository at
 * `repoPath`.  Strategy (in priority order):
 *
 *  1. Parse README.md for project name, description, architecture, and quick-
 *     start sections.
 *  2. Parse AGENTS.md for agent-specific footguns and command references.
 *  3. Parse package.json (root and sub-directories) for script names.
 *  4. Fall back to code-structure inference when documents are missing.
 *
 * @param {string} repoPath  — absolute or relative path to the repo root
 * @returns {string}         — multi-paragraph plain-English walkthrough
 */
function walkthrough(repoPath) {
  const absRepo = path.resolve(repoPath);
  const lines = [];

  // ── 1. Read source documents ──────────────────────────────────────────────
  const readmePath  = path.join(absRepo, 'README.md');
  const agentsPath  = path.join(absRepo, 'AGENTS.md');
  const pkgRootPath = path.join(absRepo, 'package.json');

  const readme = tryRead(readmePath);
  const agents = tryRead(agentsPath);
  const pkgRoot = tryReadJson(pkgRootPath);

  // ── 2. Derive project identity ────────────────────────────────────────────
  let projectName = pkgRoot && pkgRoot.name ? pkgRoot.name : path.basename(absRepo);
  let description = pkgRoot && pkgRoot.description ? pkgRoot.description : null;

  if (readme) {
    // First H1 line is the project title
    const titleMatch = readme.match(/^#\s+(.+)/m);
    if (titleMatch) projectName = titleMatch[1].trim();

    // First non-heading, non-empty paragraph after the H1 as description
    if (!description) {
      const afterTitle = readme.replace(/^#\s+.+\n/, '');
      const paraMatch = afterTitle.match(/\n([^#\n][^\n]{20,})/);
      if (paraMatch) description = paraMatch[1].trim();
    }
  }

  // ── 3. Heading ─────────────────────────────────────────────────────────────
  lines.push(`START HERE — ${projectName}`);
  lines.push('='.repeat(`START HERE — ${projectName}`.length));
  lines.push('');

  if (description) {
    lines.push(stripMarkdown(description));
    lines.push('');
  }

  // ── 4. Architecture / services ────────────────────────────────────────────
  lines.push('WHAT THIS APP IS');
  lines.push('----------------');

  let archSection = readme ? extractMdSection(readme, 'Architecture') : null;
  if (archSection) {
    // Strip code fences (ASCII art diagrams) but keep prose sentences
    const prose = archSection
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join('\n');
    if (prose) {
      lines.push(stripMarkdown(prose));
      lines.push('');
    }
  }

  // Request flow (holds) — agent-centric one-liner from AGENTS.md
  if (agents) {
    const flowMatch = agents.match(/\*\*Request flow[^*]*\*\*[:\s]+([^\n]+)/i);
    if (flowMatch) {
      lines.push('Key request flow:');
      lines.push('  ' + flowMatch[1].trim());
      lines.push('');
    }
  }

  // ── 5. Services & entry points ────────────────────────────────────────────
  lines.push('SERVICES & ENTRY POINTS');
  lines.push('-----------------------');

  // Try AGENTS.md architecture block first (concise bullet style)
  let serviceText = agents ? extractMdSection(agents, 'Architecture') : null;
  if (!serviceText && readme) {
    serviceText = extractMdSection(readme, 'Architecture');
  }

  if (serviceText) {
    // Extract lines that look like entry-point annotations (path + description)
    const epLines = serviceText
      .split('\n')
      .filter((l) => /\.(py|java|ts|js|sh)\b/.test(l))
      .map((l) => '  ' + l.trim())
      .slice(0, 12);  // cap for readability
    if (epLines.length > 0) {
      lines.push(...epLines);
      lines.push('');
    }
  }

  // Fall back to structure inference if we got nothing useful
  if (lines[lines.length - 1] !== '' || !serviceText) {
    const inferred = inferStructure(absRepo);
    if (inferred.services.length > 0) {
      lines.push('Detected services:');
      inferred.services.forEach((s) => lines.push('  • ' + s));
      lines.push('');
      lines.push('Top-level entry points:');
      inferred.entryPoints.forEach((e) => lines.push('  • ' + e));
      lines.push('');
      if (inferred.stack.length > 0) {
        lines.push('Technology stack: ' + inferred.stack.join(', '));
        lines.push('');
      }
    }
  }

  // ── 6. How to start the app ───────────────────────────────────────────────
  lines.push('HOW TO START THE APP');
  lines.push('--------------------');

  // README quick-start section
  let startSection = readme ? (
    extractMdSection(readme, 'Quick start') ||
    extractMdSection(readme, 'Getting started') ||
    extractMdSection(readme, 'Installation') ||
    extractMdSection(readme, 'Usage')
  ) : null;

  if (startSection) {
    // Prefer the first code block (the recommended command)
    const codeBlock = startSection.match(/```(?:bash|sh|shell)?\n([\s\S]*?)```/);
    if (codeBlock) {
      lines.push('Quickest way to start:');
      codeBlock[1].trim().split('\n').forEach((l) => lines.push('  ' + l));
      lines.push('');
    }

    // Then prose from this section: strip all code fences (including partial/
    // unclosed ones from sub-sections), then apply full Markdown stripping.
    const proseRaw = startSection
      .replace(/```[\s\S]*?```/g, '')   // closed fences
      .replace(/```[^\n]*/g, '')         // any remaining opening/unclosed fence lines
      .replace(/^\s*\n/gm, '\n');        // collapse newly-blank lines
    const prose = stripMarkdown(proseRaw);
    if (prose) {
      lines.push(prose);
      lines.push('');
    }
  }

  // Supplement with package.json scripts
  const scriptDirs = [absRepo];
  try {
    fs.readdirSync(absRepo, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
      .forEach((e) => scriptDirs.push(path.join(absRepo, e.name)));
  } catch { /* ignore */ }

  const scriptEntries = [];
  for (const dir of scriptDirs) {
    const pkg = tryReadJson(path.join(dir, 'package.json'));
    if (!pkg || !pkg.scripts) continue;
    const relDir = path.relative(absRepo, dir).replace(/\\/g, '/') || '.';
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      if (/\b(start|dev|serve|run)\b/.test(name)) {
        scriptEntries.push(`  ${relDir} → npm run ${name}  (${cmd})`);
      }
    }
  }
  if (scriptEntries.length > 0) {
    lines.push('npm start scripts found:');
    lines.push(...scriptEntries);
    lines.push('');
  }

  // AGENTS.md commands section
  if (agents) {
    const cmdSection = extractMdSection(agents, 'Commands');
    if (cmdSection) {
      lines.push('Per-service start commands (from AGENTS.md):');
      cmdSection
        .split('\n')
        .filter((l) => /^\s*[-*]?\s*\*\*(Run|Dev|Start|Build & run)/.test(l))
        .map((l) => '  ' + stripMarkdown(l).trim())
        .forEach((l) => lines.push(l));
      lines.push('');
    }
  }

  // ── 7. Startup sequence ───────────────────────────────────────────────────
  lines.push('WHAT HAPPENS AT STARTUP');
  lines.push('-----------------------');

  // Scan the highest-fanIn Python/JS files to identify init behaviour
  const { files, fanIn } = scanRepoGraph(absRepo);

  // Find the top entry-point file by fan-in (most-imported = most foundational)
  const topFiles = [...files.entries()]
    .map(([rp, info]) => ({ rp, fi: fanIn.get(rp) ?? 0, lines: info.content.split('\n').length }))
    .sort((a, b) => b.fi - a.fi || b.lines - a.lines)
    .slice(0, 3);

  if (topFiles.length > 0) {
    lines.push('Most-imported files (foundational layer):');
    topFiles.forEach(({ rp, fi }) => {
      lines.push(`  • ${rp}  (imported by ${fi} other file${fi !== 1 ? 's' : ''})`);
    });
    lines.push('');
  }

  // Look for lifespan / startup hooks in common entry-point files (Python + JS)
  const serverFiles = [...files.entries()].filter(([rp]) =>
    /(?:^|\/)(server|app|main|index)\.(py|js|ts|mjs)$/.test(rp)
  );
  for (const [rp, info] of serverFiles) {
    // Python ASGI lifespan hook
    const pyStartup = info.content.match(/async def lifespan[\s\S]{0,400}/);
    // Node.js: app.listen / server.listen / createServer call
    const jsStartup = info.content.match(/(?:app|server|http)\.listen\s*\([\s\S]{0,200}/);
    const startupMatch = pyStartup ?? jsStartup;
    if (startupMatch) {
      const snippet = startupMatch[0]
        .split('\n').slice(0, 10)
        .map((l) => '  ' + l).join('\n');
      lines.push(`Startup hook found in ${rp}:`);
      lines.push(snippet);
      lines.push('');
      break; // show first one only
    }
  }

  // README architectural notes that pertain to startup order
  if (readme) {
    const notesSection = extractMdSection(readme, 'Key architectural notes');
    if (notesSection) {
      const startupNotes = notesSection
        .split('\n')
        .filter((l) => /lifespan|startup|boot|order|seed|init|migration/i.test(l))
        .map((l) => '  ' + stripMarkdown(l).trim())
        .filter((l) => l.trim().length > 3);
      if (startupNotes.length > 0) {
        lines.push('Important startup-order notes:');
        lines.push(...startupNotes);
        lines.push('');
      }
    }
  }

  // ── 8. Key gotchas ────────────────────────────────────────────────────────
  if (agents) {
    const footgunsSection = extractMdSection(agents, 'Footguns');
    if (footgunsSection) {
      lines.push('KEY GOTCHAS (from AGENTS.md)');
      lines.push('----------------------------');
      const gotchas = footgunsSection
        .split('\n')
        .filter((l) => /^\s*[-*]/.test(l))
        .map((l) => '  ' + stripMarkdown(l).trim())
        .slice(0, 8);  // top 8 to keep it scannable
      lines.push(...gotchas);
      lines.push('');
    }
  }

  // ── 9. Where to look next ─────────────────────────────────────────────────
  lines.push('WHERE TO LOOK NEXT');
  lines.push('------------------');

  if (readme) {
    const furtherSection = extractMdSection(readme, 'Further reading');
    if (furtherSection) {
      const refs = furtherSection
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => '  ' + stripMarkdown(l).trim())
        .slice(0, 6);
      lines.push(...refs);
      lines.push('');
    }
  }

  // Always point to docs that exist on disk
  const docCandidates = ['AGENTS.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'docs/README.md', 'scripts/README.md'];
  const existingDocs = docCandidates.filter((d) => fs.existsSync(path.join(absRepo, d)));
  if (existingDocs.length > 0) {
    lines.push('Docs present in this repo:');
    existingDocs.forEach((d) => lines.push('  • ' + d));
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Matcher — cross-reference bug description against files and hotspots
// ---------------------------------------------------------------------------

/**
 * Extracts top-level function/method names from source content.
 * @param {string} content
 * @returns {string[]}
 */
function extractFunctionNames(content) {
  const names = new Set();
  const patterns = [
    /^\s*(?:async\s+)?function\s+(\w+)/gm,
    /(?:^|\s)(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(.*?\)\s*=>/gm,
    /^\s*(?:async\s+)?(\w+)\s*\(.*?\)\s*\{/gm,
    /^\s*def\s+(\w+)\s*\(/gm,
  ];
  for (const pat of patterns) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(content)) !== null) {
      if (m[1] && m[1].length > 2) names.add(m[1].toLowerCase());
    }
  }
  return [...names];
}

/**
 * Tokenises a bug description into lowercase words, stripping punctuation
 * and filtering out common stop-words that carry no diagnostic signal.
 * @param {string} description
 * @returns {string[]}
 */
function tokeniseDescription(description) {
  const STOP = new Set([
    'the','a','an','is','in','on','at','to','for','of','and','or','but',
    'not','with','this','that','it','be','are','was','were','has','have',
    'had','do','does','did','will','would','could','should','may','might',
    'when','where','how','what','which','who','from','into','by','as',
    'if','then','so','also','error','bug','issue','problem','fails','fail',
    'returns','return','always','never','should','expected','actual',
  ]);
  return description
    .toLowerCase()
    .replace(/[^a-z0-9_/.\-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

/**
 * Builds a one-line reason string for why a file was flagged.
 * @param {string} file
 * @param {string[]} pathHits
 * @param {string[]} funcHits
 * @param {number}   hotspotScore
 * @returns {string}
 */
function buildReason(file, pathHits, funcHits, hotspotScore) {
  const parts = [];
  if (pathHits.length > 0) {
    parts.push(`path matches: ${pathHits.slice(0, 3).join(', ')}`);
  }
  if (funcHits.length > 0) {
    parts.push(`function matches: ${funcHits.slice(0, 3).join(', ')}`);
  }
  if (hotspotScore >= 0.5) {
    parts.push(`high-risk hotspot (score ${hotspotScore.toFixed(2)})`);
  } else if (hotspotScore >= 0.3) {
    parts.push(`moderate hotspot (score ${hotspotScore.toFixed(2)})`);
  }
  return parts.length > 0 ? parts.join('; ') : `hotspot score ${hotspotScore.toFixed(2)}`;
}

/**
 * Cross-references `bugDescription` against every source file in `repoPath`.
 * Ranks suspect files by a composite signal:
 *   - keyword hits in the file path / name      (weight 0.45)
 *   - keyword hits in function / method names   (weight 0.35)
 *   - normalised hotspot score                  (weight 0.20)
 *
 * Test/spec files that happen to match keywords are penalised by a 0.3×
 * multiplier because they almost never contain the actual bug.
 *
 * @param {string} repoPath
 * @param {string} bugDescription
 * @returns {Promise<Array<{ file: string, score: number, reason: string, keywords: string[] }>>}
 */

/** Regex that matches path segments identifying test / generated artefacts. */
const TEST_PATH_RE = /(\b|[/_])(test|tests|spec|__pycache__)(\b|[/_]|$)/i;

async function matcher(repoPath, bugDescription) {
  const keywords = tokeniseDescription(bugDescription);
  if (keywords.length === 0) return [];

  // Run hotspot scoring to get per-file risk scores.
  const hotspotEntries = await hotspots(repoPath);
  if (hotspotEntries.length === 0) return [];

  // Build a lookup map for fast score retrieval.
  const scoreMap = new Map(hotspotEntries.map((e) => [e.file, e.score]));
  const maxHotspot = hotspotEntries[0].score || 1; // already sorted descending

  // Also need file content for function-name matching — reuse scanRepoGraph.
  const { files } = scanRepoGraph(repoPath);

  const results = [];

  for (const [relPath, info] of files) {
    const pathLower = relPath.toLowerCase();

    // ── Signal 1: keyword hits in file path ──────────────────────────────────
    const pathHits = keywords.filter((kw) => pathLower.includes(kw));
    const pathSignal = Math.min(pathHits.length / keywords.length, 1);

    // ── Signal 2: keyword hits in function names ──────────────────────────────
    const funcNames = extractFunctionNames(info.content);
    const funcHits  = keywords.filter((kw) =>
      funcNames.some((fn) => fn.includes(kw) || kw.includes(fn))
    );
    const funcSignal = Math.min(funcHits.length / keywords.length, 1);

    // ── Signal 3: normalised hotspot score ────────────────────────────────────
    const rawHotspot   = scoreMap.get(relPath) ?? 0;
    const hotspotSignal = rawHotspot / maxHotspot;

    let composite = 0.45 * pathSignal + 0.35 * funcSignal + 0.20 * hotspotSignal;

    // ── Penalty: test / spec / pycache paths ──────────────────────────────────
    // These files almost never contain the real bug; demote them strongly so
    // the actual source file can rank above them.
    const isTestFile = TEST_PATH_RE.test(relPath);
    if (isTestFile) composite *= 0.3;

    // Only include files with at least one keyword signal or a strong hotspot.
    if (composite === 0) continue;

    const reason = buildReason(relPath, pathHits, funcHits, rawHotspot)
      + (isTestFile ? '; test-file penalty applied (0.3×)' : '');

    results.push({
      file:    relPath,
      score:   +composite.toFixed(4),
      reason,
      keywords,
    });
  }

  // Sort highest composite score first.
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---------------------------------------------------------------------------
// Semantic fallback ranking via watsonx.ai
// ---------------------------------------------------------------------------

/**
 * Builds a compact repo summary (one line per file: relative path + first 2
 * function/class names), sends it together with the bug description to
 * watsonx.ai, and asks the model to return the top 5 most likely relevant
 * files with a one-line reason each.
 *
 * Returns an array of suspect objects in the same shape as matcher():
 *   { file, score, reason, keywords: [] }
 *
 * The score is assigned 0.04 (just below the keyword-fallback threshold of
 * 0.05) so semantic results never silently override strong keyword matches.
 *
 * Silently returns [] on any network or parse failure.
 *
 * @param {string} repoPath
 * @param {string} bugDescription
 * @returns {Promise<Array<{file:string, score:number, reason:string, keywords:string[]}>>}
 */
async function semanticRank(repoPath, bugDescription) {
  const apiKey    = process.env.WATSONX_API_KEY;
  const projectId = process.env.WATSONX_PROJECT_ID;
  const baseUrl   = (process.env.WATSONX_URL || '').replace(/\/$/, '');

  if (!apiKey || !projectId || !baseUrl) return [];

  // ── Build a compact file summary (filename + first 2 symbol names) ────────
  const absRepo = path.resolve(repoPath);
  const fileSummaries = [];
  for (const absPath of walkDir(absRepo)) {
    const relPath = path.relative(absRepo, absPath).replace(/\\/g, '/');
    const content = tryRead(absPath) || '';
    const names   = extractFunctionNames(content).slice(0, 2);
    const namesStr = names.length > 0 ? ` [${names.join(', ')}]` : '';
    fileSummaries.push(`${relPath}${namesStr}`);
  }

  if (fileSummaries.length === 0) return [];

  const fileListText = fileSummaries.join('\n');

  const prompt =
`You are a senior engineer triaging a bug report. Below is a list of files in the repository with their first few symbol names, followed by the bug description. Your task is to identify the top 5 files most likely to contain or be relevant to this bug.

Repository files:
${fileListText}

Bug description:
${bugDescription}

IMPORTANT: Only return files that appear EXACTLY as listed above. Do not invent or guess file names.
Respond ONLY with a JSON array of exactly up to 5 objects, no prose, no markdown fences:
[
  {"file": "<exact relative path>", "reason": "<one-line reason>"},
  ...
]`;

  // ── Obtain IAM token ──────────────────────────────────────────────────────
  let iamToken;
  try {
    iamToken = await new Promise((resolve, reject) => {
      const payload =
        'grant_type=urn%3Aibm%3Aparams%3Aoauth%3Agrant-type%3Aapikey&apikey=' +
        encodeURIComponent(apiKey);
      const https = require('https');
      const options = {
        hostname: 'iam.cloud.ibm.com',
        port:     443,
        path:     '/identity/token',
        method:   'POST',
        headers: {
          'Content-Type':   'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload),
          'Accept':         'application/json',
        },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try { resolve(JSON.parse(data).access_token); }
            catch (e) { reject(e); }
          } else {
            reject(new Error('IAM ' + res.statusCode));
          }
        });
      });
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  } catch (err) {
    console.warn('[bug-tracer] semanticRank: IAM token failed, skipping –', err.message);
    return [];
  }

  // ── Call watsonx.ai text generation ──────────────────────────────────────
  const modelsToTry = [
    'ibm/granite-4-h-small',
    'meta-llama/llama-3-3-70b-instruct',
  ];

  let rawText = null;
  const endpoint = `${baseUrl}/ml/v1/text/generation?version=2023-05-29`;
  const https = require('https');

  for (const modelId of modelsToTry) {
    try {
      const result = await new Promise((resolve, reject) => {
        const payload = JSON.stringify({
          model_id:   modelId,
          project_id: projectId,
          input:      prompt,
          parameters: {
            decoding_method: 'greedy',
            max_new_tokens:  400,
            min_new_tokens:  10,
            stop_sequences:  [],
          },
        });
        const parsed  = new (require('url').URL)(endpoint);
        const options = {
          hostname: parsed.hostname,
          port:     parsed.port || 443,
          path:     parsed.pathname + parsed.search,
          method:   'POST',
          headers: {
            'Content-Type':   'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'Authorization':  'Bearer ' + iamToken,
            'Accept':         'application/json',
          },
        };
        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              try { resolve(JSON.parse(data)); }
              catch (e) { reject(e); }
            } else {
              reject(new Error('HTTP ' + res.statusCode));
            }
          });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
      rawText = result?.results?.[0]?.generated_text ?? null;
      if (rawText) break;
    } catch (err) {
      console.warn(`[bug-tracer] semanticRank: model "${modelId}" failed –`, err.message);
    }
  }

  if (!rawText) {
    console.warn('[bug-tracer] semanticRank: no model returned text, skipping semantic fallback');
    return [];
  }

  // ── Parse the JSON array from the model output ────────────────────────────
  let parsed;
  try {
    // Strip any accidental markdown fences the model might add
    const cleaned = rawText.replace(/```(?:json)?/gi, '').trim();
    // Find first '[' ... last ']'
    const start = cleaned.indexOf('[');
    const end   = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1) throw new Error('no JSON array found');
    parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed)) throw new Error('parsed value is not an array');
  } catch (err) {
    console.warn('[bug-tracer] semanticRank: failed to parse LLM response –', err.message);
    return [];
  }

  // Build a set of valid repo file paths for validation
  const validPaths = new Set(fileSummaries.map((l) => l.split(' [')[0]));

  const semanticSuspects = [];
  for (const item of parsed) {
    if (!item || typeof item.file !== 'string' || typeof item.reason !== 'string') continue;
    const filePath = item.file.trim().replace(/\\/g, '/');
    // Only accept files that actually exist in the repo
    if (!validPaths.has(filePath)) continue;
    semanticSuspects.push({
      file:     filePath,
      score:    0.04,
      reason:   'semantic match: ' + item.reason.trim(),
      keywords: [],
    });
    if (semanticSuspects.length >= 5) break;
  }

  console.log('[bug-tracer] semanticRank: added', semanticSuspects.length, 'semantic suspects');
  return semanticSuspects;
}

// ---------------------------------------------------------------------------
// CLI entry-point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const hotspotFlag   = args.includes('--hotspots');
  const walkthroughFlag = args.includes('--walkthrough');
  const targetPath    = args.find((a) => !a.startsWith('--')) ?? '.';

  if (walkthroughFlag) {
    console.log(walkthrough(targetPath));
  } else if (hotspotFlag) {
    hotspots(targetPath).then((results) => {
      if (results.length === 0) {
        console.log('No analysable files found in', targetPath);
        return;
      }

      // Print a ranked table
      const header = ['Rank', 'Score', 'Lines', 'Funcs', 'FanIn', 'FanOut', 'File'];
      const rows = results.map((r, i) => [
        String(i + 1),
        r.score.toFixed(4),
        String(r.lines),
        String(r.funcs),
        String(r.fanIn),
        String(r.fanOut),
        r.file,
      ]);

      // Column widths
      const cols = header.map((h, ci) =>
        Math.max(h.length, ...rows.map((row) => row[ci].length))
      );
      const sep = cols.map((w) => '-'.repeat(w)).join('-+-');
      const fmt = (row) => row.map((cell, ci) => cell.padStart(cols[ci])).join(' | ');

      console.log(fmt(header));
      console.log(sep);
      rows.forEach((row) => console.log(fmt(row)));
    });
  } else {
    console.log(scanRepo(targetPath));
  }
}

// ---------------------------------------------------------------------------
// Graph trimming helper
// ---------------------------------------------------------------------------

/**
 * Trims a Mermaid `graph TD` string to the top `maxNodes` nodes.
 *
 * Node priority = degree (fan-in + fan-out) + a large bonus for any node
 * whose Mermaid id / label contains a keyword from the bug description.
 * This ensures bug-relevant files (e.g. flight.py) survive trimming even
 * when they have fewer total connections than unrelated hub files.
 *
 * Edges that reference a removed node are dropped.  Isolated nodes are
 * included in degree counting as degree-0 and are the first to be removed.
 *
 * If the graph already has ≤ maxNodes distinct nodes the original string is
 * returned unchanged.
 *
 * @param {string}   mermaidSrc  — full Mermaid diagram string from scanRepo()
 * @param {number}   maxNodes    — maximum number of nodes to keep (default 30)
 * @param {string[]} keywords    — tokenised bug-description keywords (optional)
 * @returns {string}             — trimmed Mermaid diagram string
 */
function trimGraph(mermaidSrc, maxNodes = 30, keywords = []) {
  const lines = mermaidSrc.split('\n');

  // degree[nodeId] = total number of edge endpoints touching this node
  const degree = new Map();
  // label[nodeId] = the display label text (lower-cased) for keyword matching
  const labelOf = new Map();

  const edgeLines     = [];  // lines containing " --> "
  const isolatedLines = [];  // declaration-only lines (no arrow)

  for (const line of lines) {
    if (line.trimStart().startsWith('graph ')) continue;

    if (line.includes(' --> ')) {
      edgeLines.push(line);
      // Extract both sides of the arrow: "  A --> B"
      // Node tokens may be bare ids or id["label"] — grab up to the first [ or space
      const m = line.match(/^\s*([^\s[]+)(?:\["([^"]+)"\])?\s*-->\s*([^\s[]+)(?:\["([^"]+)"\])?/);
      if (m) {
        const [, src, srcLabel, tgt, tgtLabel] = m;
        degree.set(src, (degree.get(src) ?? 0) + 1);
        degree.set(tgt, (degree.get(tgt) ?? 0) + 1);
        if (srcLabel && !labelOf.has(src)) labelOf.set(src, srcLabel.toLowerCase());
        if (tgtLabel && !labelOf.has(tgt)) labelOf.set(tgt, tgtLabel.toLowerCase());
      }
    } else if (line.trim().length > 0) {
      isolatedLines.push(line);
      // Isolated node declaration: grab the id token and optional label
      const m = line.match(/^\s*([^\s[]+)(?:\["([^"]+)"\])?/);
      if (m) {
        const [, id, label] = m;
        if (!degree.has(id)) degree.set(id, 0);
        if (label && !labelOf.has(id)) labelOf.set(id, label.toLowerCase());
      }
    }
  }

  const totalNodes = degree.size;
  if (totalNodes <= maxNodes) return mermaidSrc;  // nothing to trim

  /**
   * Priority score for a node.
   * A keyword match on the node's id or label adds a large bonus (1000 per
   * keyword hit) so that bug-relevant files are always preferred over
   * high-degree but unrelated hub nodes.
   */
  const kwLower = keywords.map((k) => k.toLowerCase());
  function priority(id) {
    const text = (id + ' ' + (labelOf.get(id) ?? '')).toLowerCase();
    const kwBonus = kwLower.reduce((sum, kw) => sum + (text.includes(kw) ? 1000 : 0), 0);
    return (degree.get(id) ?? 0) + kwBonus;
  }

  // Pick the top maxNodes nodes by priority (ties broken by insertion order)
  const kept = new Set(
    [...degree.keys()]
      .sort((a, b) => priority(b) - priority(a))
      .slice(0, maxNodes)
  );

  // Rebuild: keep only edges where both endpoints are in `kept`
  const out = ['graph TD'];
  for (const line of isolatedLines) {
    const m = line.match(/^\s*([^\s[]+)/);
    if (m && kept.has(m[1])) out.push(line);
  }
  for (const line of edgeLines) {
    const m = line.match(/^\s*([^\s[]+)(?:\[.*?\])?\s*-->\s*([^\s[]+)/);
    if (m && kept.has(m[1]) && kept.has(m[2])) out.push(line);
  }

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Exports (for programmatic use)
// ---------------------------------------------------------------------------

module.exports = {
  jsAdapter,
  pyAdapter,
  getAdapter,
  scanRepo,
  scanRepoGraph,
  trimGraph,
  hotspots,
  walkthrough,
  matcher,
  semanticRank,
  tokeniseDescription,
};
