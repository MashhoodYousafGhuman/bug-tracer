'use strict';

/**
 * diagnoseWithLLM
 *
 * Calls the watsonx.ai text-generation endpoint to produce a structured
 * root-cause analysis, a suggested patch, and a suggested test for the given
 * bug description and list of suspect files.
 *
 * Environment variables required (loaded from .env by the caller):
 *   WATSONX_API_KEY      – IBM Cloud API key
 *   WATSONX_PROJECT_ID   – watsonx.ai project ID
 *   WATSONX_URL          – watsonx.ai base URL
 *                          e.g. https://us-south.ml.cloud.ibm.com
 */

const https = require('https');
const http  = require('http');
const url   = require('url');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Minimal JSON GET over https/http — no external deps needed. */
function jsonGet(targetUrl, headers) {
  return new Promise((resolve, reject) => {
    const parsed  = new url.URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  { 'Accept': 'application/json', ...headers },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Failed to parse JSON response: ' + data.slice(0, 200))); }
        } else {
          reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 300)));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/** Minimal JSON POST over https/http — no external deps needed. */
function jsonPost(targetUrl, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed  = new url.URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const payload = JSON.stringify(body);

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Failed to parse JSON response: ' + data.slice(0, 200))); }
        } else {
          reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 300)));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Exchange an IBM Cloud API key for a short-lived IAM bearer token. */
async function getIamToken(apiKey) {
  return new Promise((resolve, reject) => {
    const payload = 'grant_type=urn%3Aibm%3Aparams%3Aoauth%3Agrant-type%3Aapikey&apikey=' + encodeURIComponent(apiKey);
    const options = {
      hostname: 'iam.cloud.ibm.com',
      port:     443,
      path:     '/identity/token',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
        'Accept':         'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.access_token);
          } catch (e) {
            reject(new Error('Failed to parse IAM token response'));
          }
        } else {
          reject(new Error('IAM token exchange failed: HTTP ' + res.statusCode + ' – ' + data.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetches the list of available foundation model IDs from watsonx.ai and logs
 * them to the console.  Intended as a quick diagnostic — call once at startup
 * or before the first LLM call to confirm which models are accessible on this
 * account / region.
 *
 * @param {string} baseUrl   – watsonx.ai base URL (without trailing slash)
 * @param {string} iamToken  – short-lived IAM bearer token
 */
async function listAvailableModels(baseUrl, iamToken) {
  const specsUrl = `${baseUrl}/ml/v1/foundation_model_specs?version=2024-05-01`;
  console.log('[bug-tracer] Fetching available model specs from:', specsUrl);
  try {
    const body = await jsonGet(specsUrl, { 'Authorization': 'Bearer ' + iamToken });
    const ids  = (body.resources || []).map((r) => r.model_id);
    console.log('[bug-tracer] Available model_ids on this account (' + ids.length + '):');
    ids.forEach((id) => console.log('  •', id));
    return ids;
  } catch (err) {
    console.warn('[bug-tracer] Could not fetch model specs:', err.message);
    return [];
  }
}

/**
 * Attempts to call the watsonx.ai text-generation endpoint with the given
 * model_id.  Returns the parsed response body on success, or throws on failure.
 */
async function tryGenerate(baseUrl, iamToken, projectId, modelId, prompt) {
  const endpoint = `${baseUrl}/ml/v1/text/generation?version=2023-05-29`;
  console.log('[bug-tracer] Trying model_id:', modelId);
  return jsonPost(
    endpoint,
    {
      'Authorization': 'Bearer ' + iamToken,
      'Accept':        'application/json',
    },
    {
      model_id:   modelId,
      project_id: projectId,
      input:      prompt,
      parameters: {
        decoding_method: 'greedy',
        max_new_tokens:  600,
        min_new_tokens:  30,
        stop_sequences:  [],
      },
    }
  );
}

/**
 * @param {string} bugDescription
 * @param {Array<{file: string, score: number, reason: string}>} suspects  top suspects (≤5)
 * @returns {Promise<{rootCause: string, suggestedPatch: string, suggestedTest: string}>}
 */
async function diagnoseWithLLM(bugDescription, suspects) {
  const apiKey    = process.env.WATSONX_API_KEY;
  const projectId = process.env.WATSONX_PROJECT_ID;
  const baseUrl   = (process.env.WATSONX_URL || '').replace(/\/$/, '');

  if (!apiKey || !projectId || !baseUrl) {
    throw new Error(
      'Missing watsonx.ai configuration. Set WATSONX_API_KEY, WATSONX_PROJECT_ID, and WATSONX_URL in .env'
    );
  }

  // Build a concise file list for the prompt.
  const fileList = suspects
    .slice(0, 5)
    .map((s, i) => `  ${i + 1}. ${s.file} (score ${s.score.toFixed(3)}) – ${s.reason}`)
    .join('\n');

  const prompt = `You are an expert software debugger. Given the following bug description and the top suspect files identified by static analysis, provide a structured diagnosis.

Bug description:
${bugDescription}

Top suspect files:
${fileList}

Respond in exactly this format (keep each section to 2-4 sentences or a short code block):

ROOT CAUSE:
<one paragraph explaining the most likely root cause>

SUGGESTED PATCH:
<concrete code change or steps to fix the bug>

SUGGESTED TEST:
<a short test case or test strategy to verify the fix>`;

  const iamToken = await getIamToken(apiKey);

  // ── Diagnostic: log all model IDs available on this account ─────────────
  await listAvailableModels(baseUrl, iamToken);

  // ── Try preferred model, fall back if unsupported ────────────────────────
  const modelsToTry = [
    'ibm/granite-4-h-small',
    'meta-llama/llama-3-3-70b-instruct',
  ];

  let responseBody;
  let usedModel;
  for (const modelId of modelsToTry) {
    try {
      responseBody = await tryGenerate(baseUrl, iamToken, projectId, modelId, prompt);
      usedModel = modelId;
      console.log('[bug-tracer] Success with model_id:', modelId);
      break;
    } catch (err) {
      console.warn(`[bug-tracer] model_id "${modelId}" failed:`, err.message);
    }
  }

  if (!responseBody) {
    throw new Error(
      'All model_id candidates failed: ' + modelsToTry.join(', ') +
      '. Check the console for available model IDs.'
    );
  }

  const rawText = responseBody?.results?.[0]?.generated_text ?? '';
  if (!rawText) {
    throw new Error('watsonx.ai returned an empty response from model ' + usedModel);
  }

  // Parse the structured sections out of the model output.
  function extractSection(text, heading) {
    const re = new RegExp(heading + ':\\s*([\\s\\S]*?)(?=\\n[A-Z ]+:|$)', 'i');
    const m  = text.match(re);
    return m ? m[1].trim() : '';
  }

  return {
    rootCause:      extractSection(rawText, 'ROOT CAUSE'),
    suggestedPatch: extractSection(rawText, 'SUGGESTED PATCH'),
    suggestedTest:  extractSection(rawText, 'SUGGESTED TEST'),
  };
}

module.exports = { diagnoseWithLLM };
