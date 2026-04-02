/**
 * FragCap Registry Worker
 *
 * 接收公开的 Gist ID → 从 GitHub 读取 Gist 内容 → 用 App installation token 写入 registry
 * 不接收任何用户凭证
 */

const REGISTRY_OWNER = 'fragcap';
const REGISTRY_REPO = 'registry';
const GH_API = 'https://api.github.com';
const USER_AGENT = 'FragCap-Worker/0.1';
const MAX_CAPSULES_PER_SHARD = 200;

// ─── Entry ───────────────────────────────────────────────

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
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

    if (!gist_id || typeof gist_id !== 'string') {
      return json({ ok: false, error: 'Missing or invalid gist_id' }, 400);
    }

    // 1. 获取 installation token
    const installToken = await getInstallationToken(env);

    // 2. 读取 Gist 公开内容（用 install token 可以避免未认证速率限制）
    const gist = await ghGet(`/gists/${gist_id}`, installToken);
    if (!gist) {
      return json({ ok: false, error: 'Gist not found' }, 404);
    }

    // 3. 校验 Gist 合规性
    const validation = validateGist(gist);
    if (!validation.ok) {
      return json({ ok: false, error: validation.error }, 400);
    }

    // 4. 提取摘要
    const capsule = JSON.parse(gist.files['capsule.json'].content);
    const owner = gist.owner.login;
    const shardKey = await shorthash(owner);
    const summary = {
      id: capsule.id,
      gist_id,
      tags: capsule.tags || [],
      problem: capsule.problem || '',
      status: capsule.status || 'open',
      summary: capsule.solution || capsule.problem || '',
      updated_at: new Date().toISOString()
    };

    // 5. 写入 registry 分片
    const result = await upsertShard(installToken, shardKey, owner, summary, capsule.visibility);
    return json(result, result.ok ? 200 : 500);

  } catch (err) {
    console.error('Register error:', err);
    return json({ ok: false, error: 'Internal error' }, 500);
  }
}

// ─── Gist 校验 ──────────────────────────────────────────

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

  // 验证 capsule.json 内容可解析
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

// ─── Registry 分片读写 ──────────────────────────────────

async function upsertShard(token, shardKey, owner, summary, visibility) {
  const path = `shards/${shardKey}.json`;

  // 读取现有分片
  let sha = null;
  let shard = {
    version: 1,
    author: `gh:anonymous-${shardKey}`,
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
    // 404 = 新用户，用空分片
  }

  // 设置 author
  if (visibility === 'attributed') {
    shard.author = `gh:${owner}`;
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

  // 写回（带重试）
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

    // 409 Conflict → 重新读取 sha 再试一次
    if (putRes.status === 409 && attempt === 0) {
      try {
        const fresh = await ghGet(
          `/repos/${REGISTRY_OWNER}/${REGISTRY_REPO}/contents/${path}`,
          token
        );
        sha = fresh.sha;
        const decoded = atob(fresh.content.replace(/\n/g, ''));
        const freshShard = JSON.parse(decoded);
        // 重新 upsert
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

// ─── GitHub App 认证 ────────────────────────────────────

async function getInstallationToken(env) {
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
  return data.token;
}

/**
 * 用 Web Crypto API 签发 JWT（RS256）
 * Cloudflare Workers 不支持 Node.js crypto，必须用 Web Crypto
 */
async function createJWT(appId, privateKeyPem) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60,       // 60 秒前，允许时钟偏移
    exp: now + 10 * 60,  // 10 分钟有效期
    iss: appId
  };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  // 导入 PEM 私钥
  const key = await importPrivateKey(privateKeyPem);

  // 签名
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

  // 尝试 PKCS8 格式（BEGIN PRIVATE KEY）
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      binaryDer.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
  } catch {
    // 如果失败，可能是 PKCS1 格式（BEGIN RSA PRIVATE KEY）
    // Cloudflare Workers 的 Web Crypto 通常支持 PKCS8
    // GitHub 下载的 .pem 一般是 PKCS1，需要转换
    throw new Error(
      'Failed to import private key. ' +
      'GitHub App PEM files are PKCS1 format. ' +
      'Convert to PKCS8: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem'
    );
  }
}

// ─── GitHub API 辅助 ────────────────────────────────────

async function ghGet(path, token) {
  const res = await fetch(`${GH_API}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
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

// ─── 工具函数 ───────────────────────────────────────────

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
    .slice(0, 4);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders()
    }
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
