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
      return json({ ok: true, service: 'fragcap-worker' });
    }

    return json({ ok: false, error: 'Not found' }, 404);
  }
};

// ─── /register ───────────────────────────────────────────

async function handleRegister(request, env) {
  try {
    const body = await request.json();
    const { gist_id } = body;

    if (!gist_id || typeof gist_id !== 'string' || !/^[a-f0-9]{20,32}$/i.test(gist_id)) {
      return json({ ok: false, error: 'Missing or invalid gist_id' }, 400);
    }

    // 1. Get installation token (used to write to registry)
    const installToken = await getInstallationToken(env);

    // 2. Read public Gist content — owner identity comes from GitHub's own API response
    const gist = await ghGet(`/gists/${gist_id}`);
    if (!gist) {
      return json({ ok: false, error: 'Gist not found' }, 404);
    }

    const owner = gist.owner.login;

    // 3. Rate limit: max RATE_LIMIT_PER_DAY registrations per gist owner per UTC day
    const rateLimitResult = await checkRateLimit(env.RATE_LIMIT, owner);
    if (!rateLimitResult.ok) {
      return json({ ok: false, error: rateLimitResult.error }, 429);
    }

    // 4. Validate gist compliance
    const validation = validateGist(gist);
    if (!validation.ok) {
      return json({ ok: false, error: validation.error }, 400);
    }

    // 5. Extract summary
    const capsule = JSON.parse(gist.files['capsule.json'].content);
    const shardKey = await shorthash(owner);
    const summary = {
      id: capsule.id,
      gist_id,
      tags: capsule.tags || [],
      problem: capsule.problem || '',
      status: capsule.status || 'open',
      author: capsule.author || `gh:anonymous-${shardKey}`,
      summary: capsule.solution || capsule.problem || '',
      updated_at: new Date().toISOString()
    };

    // 6. Write to registry shard
    const result = await upsertShard(installToken, shardKey, owner, summary, capsule.visibility);
    if (result.ok) await incrementRateLimit(env.RATE_LIMIT, owner);
    return json(result, result.ok ? 200 : 500);

  } catch (err) {
    console.error('Register error:', err);
    return json({ ok: false, error: 'Internal error' }, 500);
  }
}

// ─── Rate limiting (KV-backed, per owner per UTC day) ─────────────────────────

function rateLimitKey(owner) {
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
  return `rl:${owner}:${today}`;
}

async function checkRateLimit(kv, owner) {
  const key = rateLimitKey(owner);
  const current = parseInt(await kv.get(key) ?? '0', 10);
  if (current >= RATE_LIMIT_PER_DAY) {
    return { ok: false, error: `Rate limit exceeded — max ${RATE_LIMIT_PER_DAY} registrations per day` };
  }
  return { ok: true };
}

async function incrementRateLimit(kv, owner) {
  const key = rateLimitKey(owner);
  const current = parseInt(await kv.get(key) ?? '0', 10);
  // TTL of 25 hours ensures the key expires shortly after the UTC day rolls over
  await kv.put(key, String(current + 1), { expirationTtl: 90000 });
}

// ─── Gist validation ──────────────────────────────────────────

function validateGist(gist) {
  if (!gist.public) {
    return { ok: false, error: 'Gist is not public' };
  }
  if (!gist.description || !gist.description.includes('[fragcap]')) {
    return { ok: false, error: 'Gist description must contain [fragcap]' };
  }
  if (!gist.files || !gist.files['capsule.json']) {
    return { ok: false, error: 'Gist must contain capsule.json' };
  }

  // Verify capsule.json content is parseable
  try {
    const capsule = JSON.parse(gist.files['capsule.json'].content);
    if (!capsule.id || !capsule.tags || !capsule.problem) {
      return { ok: false, error: 'capsule.json missing required fields (id, tags, problem)' };
    }
  } catch {
    return { ok: false, error: 'capsule.json is not valid JSON' };
  }

  return { ok: true };
}

// ─── Registry shard read/write ──────────────────────────────────

async function upsertShard(token, shardKey, owner, summary, visibility) {
  const path = `shards/${shardKey}.json`;

  // Read existing shard
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

  // Upsert capsule
  const idx = shard.capsules.findIndex(c => c.id === summary.id);
  if (idx >= 0) {
    shard.capsules[idx] = summary;
  } else {
    if (shard.capsules.length >= MAX_CAPSULES_PER_SHARD) {
      return { ok: false, error: `Capsule limit reached (${MAX_CAPSULES_PER_SHARD})` };
    }
    shard.capsules.push(summary);
  }
  shard.updated_at = new Date().toISOString();

  // Write back (with retry)
  for (let attempt = 0; attempt < 2; attempt++) {
    const putRes = await ghPut(
      `/repos/${REGISTRY_OWNER}/${REGISTRY_REPO}/contents/${path}`,
      token,
      {
        message: `update shard ${shardKey}`,
        content: btoa(JSON.stringify(shard, null, 2)),
        ...(sha ? { sha } : {})
      }
    );

    if (putRes.ok) {
      return { ok: true };
    }

    // 409 Conflict → re-fetch sha and retry once
    if (putRes.status === 409 && attempt === 0) {
      try {
        const fresh = await ghGet(
          `/repos/${REGISTRY_OWNER}/${REGISTRY_REPO}/contents/${path}`,
          token
        );
        sha = fresh.sha;
        const decoded = atob(fresh.content.replace(/\n/g, ''));
        const freshShard = JSON.parse(decoded);
        // Re-upsert
        const fIdx = freshShard.capsules.findIndex(c => c.id === summary.id);
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
    const text = await res.text();
    throw new Error(`Failed to get installation token: ${res.status} ${text}`);
  }

  const data = await res.json();
  cachedToken = data.token;
  tokenExpiresAt = new Date(data.expires_at).getTime();
  return cachedToken;
}

/**
 * Sign a JWT (RS256) using the Web Crypto API
 * Cloudflare Workers does not support Node.js crypto — Web Crypto must be used
 */
async function createJWT(appId, privateKeyPem) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,       // 60 seconds in the past to allow for clock skew
    exp: now + 10 * 60,  // 10-minute validity
    iss: appId
  };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  // Import PEM private key
  const key = await importPrivateKey(privateKeyPem);

  // Sign
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

  // Try PKCS8 format (BEGIN PRIVATE KEY)
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      binaryDer.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
  } catch {
    // If that fails, it may be PKCS1 format (BEGIN RSA PRIVATE KEY)
    // Cloudflare Workers Web Crypto generally supports PKCS8
    // GitHub-downloaded .pem files are typically PKCS1 and must be converted
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
  if (!res.ok) return null;
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
    // ArrayBuffer
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
