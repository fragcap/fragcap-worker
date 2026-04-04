/**
 * FragCap Registry Worker
 *
 * Accepts a public Gist ID → reads Gist content from GitHub → writes to registry using App installation token
 * Does not accept or store any user credentials.
 * Rate limiting is enforced per gist owner using Cloudflare KV (env.RATE_LIMIT).
 */

const REGISTRY_OWNER = 'fragcap';
const REGISTRY_REPO = 'registry';
const GH_API = 'https://api.github.com';
const USER_AGENT = 'FragCap-Worker/0.1';
const MAX_CAPSULES_PER_SHARD = 200;
const RATE_LIMIT_PER_DAY = 20;

// ─── Entry ───────────────────────────────────────────────

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);

    if (url.pathname === '/register' && request.method === 'POST') {
      return handleRegister(request, env);
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, service: 'fragcap-worker' }, 200, request);
    }

    return json({ ok: false, error: 'Not found' }, 404, request);
  }
};

// ─── Frontmatter parser ──────────────────────────────────

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w[\w_-]*)\s*:\s*(.+)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[m[1]] = val;
  }
  return { meta, body: match[2] };
}

function extractSection(body, heading) {
  const re = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im');
  const match = body.match(re);
  if (!match) return '';
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const nextHeading = rest.match(/^##\s+/m);
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  return section.trim();
}

// ─── /register ───────────────────────────────────────────

async function handleRegister(request, env) {
  try {
    if (!request.headers.get('content-type')?.includes('application/json')) {
      return json({ ok: false, error: 'Content-Type must be application/json' }, 415, request);
    }

    const body = await request.json();
    const { gist_id } = body;

    if (!gist_id || typeof gist_id !== 'string' || !/^[a-f0-9]{20,32}$/i.test(gist_id)) {
      return json({ ok: false, error: 'Missing or invalid gist_id' }, 400, request);
    }

    // 1. Get installation token (used to write to registry)
    const installToken = await getInstallationToken(env);

    // 2. Read public Gist content — owner identity comes from GitHub's own API response
    const gist = await ghGet(`/gists/${gist_id}`, env.GIST_READ_TOKEN);
    if (!gist) {
      return json({ ok: false, error: 'Gist not found' }, 404, request);
    }

    const owner = gist.owner.login;

    // 3. Rate limit: max RATE_LIMIT_PER_DAY registrations per gist owner per UTC day
    const rateLimitResult = await acquireRateLimit(env.RATE_LIMIT, owner);
    if (!rateLimitResult.ok) {
      return json({ ok: false, error: rateLimitResult.error }, 429, request);
    }

    // 4. Validate gist compliance
    const validation = validateGist(gist);
    if (!validation.ok) {
      return json({ ok: false, error: validation.error }, 400, request);
    }

    // 5. Extract summary from SKILL.md frontmatter and body
    const content = gist.files['SKILL.md'].content;
    const { meta, body: mdBody } = parseFrontmatter(content);
    const shardKey = await shorthash(owner);
    const truncate = (str, max) => typeof str === 'string' ? str.slice(0, max) : '';

    const problem = (meta.description || '').replace(/\\"/g, '"');
    const solution = extractSection(mdBody, 'Fix') || extractSection(mdBody, 'Solution');

    const summary = {
      id: truncate(meta.id || gist_id, 128),
      gist_id,
      tags: (Array.isArray(meta.tags) ? meta.tags : []).slice(0, 10).map(t => truncate(String(t), 50)),
      problem: truncate(problem, 500),
      status: ['open', 'resolved', 'abandoned'].includes(meta.status) ? meta.status : 'open',
      author: truncate(meta.author || `gh:anonymous-${shardKey}`, 64),
      summary: truncate(solution || problem, 500),
      updated_at: new Date().toISOString()
    };

    // 6. Write to registry shard
    const result = await upsertShard(installToken, shardKey, owner, summary, meta.visibility);
    if (!result.ok) await releaseRateLimit(env.RATE_LIMIT, owner);
    return json(result, result.ok ? 200 : 500, request);

  } catch (err) {
    console.error('Register error:', err);
    return json({ ok: false, error: 'Internal error' }, 500, request);
  }
}

// ─── Rate limiting (KV-backed, per owner per UTC day) ─────────────────────────

function rateLimitKey(owner) {
  const today = new Date().toISOString().slice(0, 10);
  return `rl:${owner}:${today}`;
}

async function acquireRateLimit(kv, owner) {
  const key = rateLimitKey(owner);
  const current = parseInt(await kv.get(key) ?? '0', 10);
  if (current >= RATE_LIMIT_PER_DAY) {
    return { ok: false, error: `Rate limit exceeded — max ${RATE_LIMIT_PER_DAY} registrations per day` };
  }
  await kv.put(key, String(current + 1), { expirationTtl: 90000 });
  return { ok: true };
}

async function releaseRateLimit(kv, owner) {
  const key = rateLimitKey(owner);
  const current = parseInt(await kv.get(key) ?? '1', 10);
  await kv.put(key, String(Math.max(0, current - 1)), { expirationTtl: 90000 });
}

// ─── Gist validation ──────────────────────────────────────────

function validateGist(gist) {
  if (!gist.public) {
    return { ok: false, error: 'Gist is not public' };
  }
  if (!gist.description || !gist.description.includes('[fragcap]')) {
    return { ok: false, error: 'Gist description must contain [fragcap]' };
  }
  if (!gist.files || !gist.files['SKILL.md']) {
    return { ok: false, error: 'Gist must contain SKILL.md' };
  }

  const content = gist.files['SKILL.md'].content;
  if (content.length > 102400) {
    return { ok: false, error: 'SKILL.md exceeds maximum size (100 KB)' };
  }

  // Validate frontmatter
  const { meta } = parseFrontmatter(content);
  if (!meta.id || !meta.tags || !meta.description) {
    return { ok: false, error: 'SKILL.md frontmatter missing required fields (id, tags, description)' };
  }
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  if (tags.length > 10) {
    return { ok: false, error: 'tags must have at most 10 items' };
  }
  if (typeof meta.description === 'string' && meta.description.length > 500) {
    return { ok: false, error: 'description field exceeds 500 characters' };
  }

  return { ok: true };
}

// ─── Registry shard read/write ──────────────────────────────────

function utf8ToBase64(str) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)));
}

async function upsertShard(token, shardKey, owner, summary, visibility) {
  const path = `shards/${shardKey}.json`;

  let sha = null;
  let shard = {
    version: 1,
    updated_at: new Date().toISOString(),
    capsules: []
  };

  try {
    const existing = await ghGet(
      `/repos/${REGISTRY_OWNER}/${REGISTRY_REPO}/contents/${path}`,
      token
    );
    if (existing && existing.sha) {
      sha = existing.sha;
      const decoded = atob(existing.content.replace(/\n/g, ''));
      shard = JSON.parse(decoded);
    }
  } catch {
    // 404 = new user, use empty shard
  }

  const idx = shard.capsules.findIndex(c => c.gist_id === summary.gist_id);
  if (idx >= 0) {
    shard.capsules[idx] = summary;
  } else {
    if (shard.capsules.length >= MAX_CAPSULES_PER_SHARD) {
      return { ok: false, error: `Capsule limit reached (${MAX_CAPSULES_PER_SHARD})` };
    }
    shard.capsules.push(summary);
  }
  shard.updated_at = new Date().toISOString();

  for (let attempt = 0; attempt < 2; attempt++) {
    const putRes = await ghPut(
      `/repos/${REGISTRY_OWNER}/${REGISTRY_REPO}/contents/${path}`,
      token,
      {
        message: `update shard ${shardKey}`,
        content: utf8ToBase64(JSON.stringify(shard, null, 2)),
        ...(sha ? { sha } : {})
      }
    );

    if (putRes.ok) {
      return { ok: true };
    }

    if (putRes.status === 409 && attempt === 0) {
      try {
        const fresh = await ghGet(
          `/repos/${REGISTRY_OWNER}/${REGISTRY_REPO}/contents/${path}`,
          token
        );
        sha = fresh.sha;
        const decoded = atob(fresh.content.replace(/\n/g, ''));
        const freshShard = JSON.parse(decoded);
        const fIdx = freshShard.capsules.findIndex(c => c.gist_id === summary.gist_id);
        if (fIdx >= 0) freshShard.capsules[fIdx] = summary;
        else freshShard.capsules.push(summary);
        freshShard.updated_at = new Date().toISOString();
        shard = freshShard;
      } catch {
        return { ok: false, error: 'Conflict retry failed' };
      }
      continue;
    }

    return { ok: false, error: `Registry write failed (${putRes.status})` };
  }

  return { ok: false, error: 'Registry write failed after retry' };
}

// ─── GitHub App authentication ────────────────────────────────────

let cachedToken = null;
let tokenExpiresAt = 0;

async function getInstallationToken(env) {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const jwt = await createJWT(env.APP_ID, env.PRIVATE_KEY);

  const res = await fetch(
    `${GH_API}/app/installations/${env.INSTALLATION_ID}/access_tokens`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        repositories: [REGISTRY_REPO],
        permissions: { contents: 'write' }
      })
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to get installation token: HTTP ${res.status}`);
  }

  const data = await res.json();
  cachedToken = data.token;
  tokenExpiresAt = new Date(data.expires_at).getTime();
  return cachedToken;
}

async function createJWT(appId, privateKeyPem) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,
    exp: now + 10 * 60,
    iss: appId
  };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importPrivateKey(privateKeyPem);

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );

  const signatureB64 = base64url(signature);
  return `${signingInput}.${signatureB64}`;
}

async function importPrivateKey(pem) {
  const pemContents = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, '')
    .replace(/-----END RSA PRIVATE KEY-----/g, '')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');

  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      binaryDer.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
  } catch {
    throw new Error(
      'Failed to import private key. ' +
      'GitHub App PEM files are PKCS1 format. ' +
      'Convert to PKCS8: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem'
    );
  }
}

// ─── GitHub API helpers ────────────────────────────────────

async function ghGet(path, token = null) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${GH_API}${path}`, { headers });
  if (!res.ok) {
    console.warn(`ghGet ${path} failed: ${res.status}`);
    return null;
  }
  return res.json();
}

async function ghPut(path, token, body) {
  const res = await fetch(`${GH_API}${path}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify(body)
  });
  return { ok: res.ok, status: res.status };
}

// ─── Utilities ───────────────────────────────────────────

function base64url(input) {
  let b64;
  if (typeof input === 'string') {
    b64 = btoa(input);
  } else {
    b64 = btoa(String.fromCharCode(...new Uint8Array(input)));
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function shorthash(str) {
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 8);
}

function json(data, status = 200, request = null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request)
    }
  });
}

function corsHeaders(request) {
  const origin = request?.headers?.get('Origin') || '';
  const allowed = ['https://fragcap.github.io'];
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : '',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
