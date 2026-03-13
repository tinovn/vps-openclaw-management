#!/usr/bin/env node
// =============================================================================
// OpenClaw Management API — Docker Compose based service management
// Auth: Bearer OPENCLAW_MGMT_API_KEY | Port: 9998 | Systemd: openclaw-mgmt.service
// =============================================================================

const http = require('http');
const { execSync, exec } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const PORT = 9998;
const COMPOSE_DIR = '/opt/openclaw';
const COMPOSE_CMD = `docker compose -f ${COMPOSE_DIR}/docker-compose.yml`;
const CONFIG_DIR = `${COMPOSE_DIR}/config`;
const ENV_FILE = `${COMPOSE_DIR}/.env`;
const CADDYFILE = `${COMPOSE_DIR}/Caddyfile`;
const TEMPLATES_DIR = '/etc/openclaw/config';
const AUTH_PROFILES_DIR = `${CONFIG_DIR}/agents/main/agent`;
const AUTH_PROFILES_FILE = `${AUTH_PROFILES_DIR}/auth-profiles.json`;

// --- Login user credentials (stored in .env) ---
const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = { N: 16384, r: 8, p: 1 };

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_COST).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_COST).toString('hex');
  if (test.length !== hash.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(test), Buffer.from(hash)); }
  catch { return false; }
}

function getLoginUser() {
  return getEnvValue('OPENCLAW_LOGIN_USER');
}

function getLoginPass() {
  return getEnvValue('OPENCLAW_LOGIN_PASS');
}

const MAX_AUTH_FAILURES = 10;
const BLOCK_DURATION = 15 * 60 * 1000;
const authAttempts = {};

// IP Whitelist — only these IPs can access the Management API
const ALLOWED_IPS = [
  '103.130.216.5',
  '103.130.216.57',
  '103.130.216.58',
  '103.241.42.12',
  '103.241.42.10',
  '103.130.217.10',
  '127.0.0.1',       // localhost
  '::1',             // localhost IPv6
];

// =============================================================================
// Helpers
// =============================================================================
function getClientIP(req) {
  return req.socket.remoteAddress.replace('::ffff:', '');
}

function isBlocked(ip) {
  const r = authAttempts[ip];
  if (!r) return false;
  if (r.blockedUntil && Date.now() < r.blockedUntil) return true;
  if (r.blockedUntil && Date.now() >= r.blockedUntil) { delete authAttempts[ip]; return false; }
  return false;
}

function recordFailedAuth(ip) {
  if (!authAttempts[ip]) authAttempts[ip] = { count: 0, blockedUntil: null };
  authAttempts[ip].count++;
  if (authAttempts[ip].count >= MAX_AUTH_FAILURES) {
    authAttempts[ip].blockedUntil = Date.now() + BLOCK_DURATION;
  }
}

function getMgmtApiKey() {
  try {
    const env = fs.readFileSync(ENV_FILE, 'utf8');
    const m = env.match(/^OPENCLAW_MGMT_API_KEY=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

function isAuthorized(req) {
  const auth = req.headers.authorization || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const expected = getMgmtApiKey();
  if (!expected) return false;
  const provided = match[1];
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch { return false; }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) { req.destroy(); reject(new Error('Too large')); } });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); } });
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sanitizeKey(key) {
  if (!key || key.length < 12) return '***';
  return key.substring(0, 8) + '...' + key.substring(key.length - 4);
}

function getServerIP() {
  try { return execSync("hostname -I | awk '{print $1}'", { stdio: 'pipe' }).toString().trim(); }
  catch { return 'localhost'; }
}

function shell(cmd, timeout = 30000) {
  return execSync(cmd, { timeout, stdio: 'pipe' }).toString().trim();
}

// --- Env file helpers ---
function readEnvFile() {
  return fs.readFileSync(ENV_FILE, 'utf8');
}

function writeEnvFile(content) {
  fs.writeFileSync(ENV_FILE, content, 'utf8');
}

function getEnvValue(key) {
  const env = readEnvFile();
  const m = env.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1] : null;
}

function setEnvValue(key, value) {
  let env = readEnvFile();
  const regex = new RegExp(`^#?\\s*${key}=.*$`, 'm');
  if (regex.test(env)) {
    env = env.replace(regex, `${key}=${value}`);
  } else {
    env = env.trim() + `\n${key}=${value}\n`;
  }
  writeEnvFile(env.trim() + '\n');
}

function removeEnvValue(key) {
  let env = readEnvFile();
  env = env.replace(new RegExp(`^#?\\s*${key}=.*\n?`, 'm'), '');
  writeEnvFile(env.trim() + '\n');
}

function getDomainFromCaddyfile() {
  try {
    const caddy = fs.readFileSync(CADDYFILE, 'utf8');
    for (const rawLine of caddy.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([^\s{][^{]*)\s*\{$/);
      if (!m) continue;
      const firstHost = m[1].split(',')[0].trim();
      if (!firstHost || firstHost.startsWith('{$') || firstHost === 'localhost') return null;
      return firstHost;
    }
  } catch {}
  return null;
}

function getConfiguredDomainRaw() {
  const envDomain = (getEnvValue('DOMAIN') || '').trim();
  if (envDomain && envDomain !== 'localhost') return envDomain;
  return getDomainFromCaddyfile();
}

// --- Config file helpers ---
function readConfig() {
  return JSON.parse(fs.readFileSync(`${CONFIG_DIR}/openclaw.json`, 'utf8'));
}

function writeConfig(config) {
  fs.writeFileSync(`${CONFIG_DIR}/openclaw.json`, JSON.stringify(config, null, 2), 'utf8');
}

// --- Auth profiles helpers ---
function getAgentAuthDir(agentId) {
  return `${CONFIG_DIR}/agents/${agentId}/agent`;
}

function getAgentAuthFile(agentId) {
  return `${getAgentAuthDir(agentId)}/auth-profiles.json`;
}

function readAgentAuth(agentId) {
  try {
    return JSON.parse(fs.readFileSync(getAgentAuthFile(agentId), 'utf8'));
  } catch {
    return { profiles: {} };
  }
}

function writeAgentAuth(agentId, profiles) {
  const dir = getAgentAuthDir(agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getAgentAuthFile(agentId), JSON.stringify(profiles, null, 2), 'utf8');
}

function setAgentApiKey(agentId, providerName, apiKey) {
  const data = readAgentAuth(agentId);
  data.profiles = data.profiles || {};
  const profileId = `${providerName}:manual`;
  data.profiles[profileId] = {
    type: 'api_key',
    provider: providerName,
    key: apiKey
  };
  writeAgentAuth(agentId, data);
}

function getAgentApiKey(agentId, providerName) {
  const data = readAgentAuth(agentId);
  const profiles = data.profiles || {};
  for (const [id, profile] of Object.entries(profiles)) {
    if (profile && profile.provider === providerName && profile.key) return profile.key;
  }
  return null;
}

function removeAgentApiKey(agentId, providerName) {
  const data = readAgentAuth(agentId);
  if (!data.profiles) return;
  const profileId = `${providerName}:manual`;
  if (data.profiles[profileId]) {
    delete data.profiles[profileId];
    writeAgentAuth(agentId, data);
  }
}

// Backward-compatible wrappers (default to 'main' agent)
function readAuthProfiles(agentId = 'main') {
  return readAgentAuth(agentId);
}

function writeAuthProfiles(profiles, agentId = 'main') {
  writeAgentAuth(agentId, profiles);
}

function setAuthProfileApiKey(providerName, apiKey, agentId = 'main') {
  setAgentApiKey(agentId, providerName, apiKey);
}

function getAuthProfileApiKey(providerName, agentId = 'main') {
  return getAgentApiKey(agentId, providerName);
}

// --- Route matching ---
function route(req, method, path) {
  if (req.method !== method) return null;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pattern = path.replace(/:(\w+)/g, '(?<$1>[^/]+)');
  const match = url.pathname.match(new RegExp(`^${pattern}$`));
  if (!match) return null;
  return { params: match.groups || {}, query: Object.fromEntries(url.searchParams) };
}

// --- Multi-agent helpers ---
function isValidAgentId(id) {
  return typeof id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(id);
}

function getAgentsList(config) {
  const list = config?.agents?.list;
  if (Array.isArray(list) && list.length > 0) return list;
  return [{ id: 'main', default: true, name: 'Main Agent' }];
}

function getDefaultAgentId(config) {
  const list = getAgentsList(config);
  const def = list.find(a => a.default);
  return def ? def.id : (list[0]?.id || 'main');
}

function ensureAgentsList(config) {
  if (!config.agents) config.agents = {};
  if (!Array.isArray(config.agents.list)) config.agents.list = [];
  return config;
}

function getBindings(config) {
  return Array.isArray(config.bindings) ? config.bindings : [];
}

// --- Provider aliases (e.g. "google" → "gemini") ---
const PROVIDER_ALIASES = { google: 'gemini' };
function resolveProvider(name) { return PROVIDER_ALIASES[name] || name; }

// --- Provider configs ---
// Helper: test API key via Bearer auth + GET /models endpoint
function testBearerModels(url, apiKey) {
  try {
    const r = shell(`curl -s -o /dev/null -w '%{http_code}' '${url}' \
      -H 'Authorization: Bearer ${apiKey.replace(/'/g, "'\\''")}' `, 15000);
    return r === '200';
  } catch { return false; }
}

const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    authProfileProvider: 'anthropic',
    configTemplate: `${TEMPLATES_DIR}/anthropic.json`,
    testFn: (apiKey) => {
      try {
        const r = shell(`curl -s -o /dev/null -w '%{http_code}' -X POST https://api.anthropic.com/v1/messages \
          -H 'x-api-key: ${apiKey.replace(/'/g, "'\\''")}' \
          -H 'anthropic-version: 2023-06-01' \
          -H 'content-type: application/json' \
          -d '{"model":"claude-sonnet-4-20250514","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'`, 15000);
        return r === '200';
      } catch { return false; }
    }
  },
  openai: {
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    authProfileProvider: 'openai',
    configTemplate: `${TEMPLATES_DIR}/openai.json`,
    testFn: (apiKey) => testBearerModels('https://api.openai.com/v1/models', apiKey)
  },
  gemini: {
    name: 'Google Gemini',
    envKey: 'GEMINI_API_KEY',
    authProfileProvider: 'google',
    configTemplate: `${TEMPLATES_DIR}/gemini.json`,
    testFn: (apiKey) => {
      try {
        const r = shell(`curl -s -o /dev/null -w '%{http_code}' \
          "https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey.replace(/'/g, "'\\''")}"`, 15000);
        return r === '200';
      } catch { return false; }
    }
  },
  deepseek: {
    name: 'DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    authProfileProvider: 'deepseek',
    configTemplate: `${TEMPLATES_DIR}/deepseek.json`,
    testFn: (apiKey) => testBearerModels('https://api.deepseek.com/v1/models', apiKey)
  },
  groq: {
    name: 'Groq',
    envKey: 'GROQ_API_KEY',
    authProfileProvider: 'groq',
    configTemplate: `${TEMPLATES_DIR}/groq.json`,
    testFn: (apiKey) => testBearerModels('https://api.groq.com/openai/v1/models', apiKey)
  },
  together: {
    name: 'Together AI',
    envKey: 'TOGETHER_API_KEY',
    authProfileProvider: 'together',
    configTemplate: `${TEMPLATES_DIR}/together.json`,
    testFn: (apiKey) => testBearerModels('https://api.together.xyz/v1/models', apiKey)
  },
  mistral: {
    name: 'Mistral AI',
    envKey: 'MISTRAL_API_KEY',
    authProfileProvider: 'mistral',
    configTemplate: `${TEMPLATES_DIR}/mistral.json`,
    testFn: (apiKey) => testBearerModels('https://api.mistral.ai/v1/models', apiKey)
  },
  xai: {
    name: 'xAI (Grok)',
    envKey: 'XAI_API_KEY',
    authProfileProvider: 'xai',
    configTemplate: `${TEMPLATES_DIR}/xai.json`,
    testFn: (apiKey) => testBearerModels('https://api.x.ai/v1/models', apiKey)
  },
  cerebras: {
    name: 'Cerebras',
    envKey: 'CEREBRAS_API_KEY',
    authProfileProvider: 'cerebras',
    configTemplate: `${TEMPLATES_DIR}/cerebras.json`,
    testFn: (apiKey) => testBearerModels('https://api.cerebras.ai/v1/models', apiKey)
  },
  sambanova: {
    name: 'SambaNova',
    envKey: 'SAMBANOVA_API_KEY',
    authProfileProvider: 'sambanova',
    configTemplate: `${TEMPLATES_DIR}/sambanova.json`,
    testFn: (apiKey) => testBearerModels('https://api.sambanova.ai/v1/models', apiKey)
  },
  fireworks: {
    name: 'Fireworks AI',
    envKey: 'FIREWORKS_API_KEY',
    authProfileProvider: 'fireworks',
    configTemplate: `${TEMPLATES_DIR}/fireworks.json`,
    testFn: (apiKey) => testBearerModels('https://api.fireworks.ai/inference/v1/models', apiKey)
  },
  cohere: {
    name: 'Cohere',
    envKey: 'COHERE_API_KEY',
    authProfileProvider: 'cohere',
    configTemplate: `${TEMPLATES_DIR}/cohere.json`,
    testFn: (apiKey) => testBearerModels('https://api.cohere.ai/compatibility/v1/models', apiKey)
  },
  yi: {
    name: 'Yi/01.AI',
    envKey: 'YI_API_KEY',
    authProfileProvider: 'yi',
    configTemplate: `${TEMPLATES_DIR}/yi.json`,
    testFn: (apiKey) => testBearerModels('https://api.01.ai/v1/models', apiKey)
  },
  baichuan: {
    name: 'Baichuan AI',
    envKey: 'BAICHUAN_API_KEY',
    authProfileProvider: 'baichuan',
    configTemplate: `${TEMPLATES_DIR}/baichuan.json`,
    testFn: (apiKey) => testBearerModels('https://api.baichuan-ai.com/v1/models', apiKey)
  },
  stepfun: {
    name: 'Stepfun',
    envKey: 'STEPFUN_API_KEY',
    authProfileProvider: 'stepfun',
    configTemplate: `${TEMPLATES_DIR}/stepfun.json`,
    testFn: (apiKey) => testBearerModels('https://api.stepfun.com/v1/models', apiKey)
  },
  siliconflow: {
    name: 'SiliconFlow',
    envKey: 'SILICONFLOW_API_KEY',
    authProfileProvider: 'siliconflow',
    configTemplate: `${TEMPLATES_DIR}/siliconflow.json`,
    testFn: (apiKey) => testBearerModels('https://api.siliconflow.cn/v1/models', apiKey)
  },
  novita: {
    name: 'Novita AI',
    envKey: 'NOVITA_API_KEY',
    authProfileProvider: 'novita',
    configTemplate: `${TEMPLATES_DIR}/novita.json`,
    testFn: (apiKey) => testBearerModels('https://api.novita.ai/v3/openai/models', apiKey)
  },
  openrouter: {
    name: 'OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    authProfileProvider: 'openrouter',
    configTemplate: `${TEMPLATES_DIR}/openrouter.json`,
    testFn: (apiKey) => testBearerModels('https://openrouter.ai/api/v1/models', apiKey)
  },
  minimax: {
    name: 'Minimax',
    envKey: 'MINIMAX_API_KEY',
    authProfileProvider: 'minimax',
    configTemplate: `${TEMPLATES_DIR}/minimax.json`,
    testFn: (apiKey) => testBearerModels('https://api.minimax.io/v1/models', apiKey)
  },
  moonshot: {
    name: 'Moonshot/Kimi',
    envKey: 'MOONSHOT_API_KEY',
    authProfileProvider: 'moonshot',
    configTemplate: `${TEMPLATES_DIR}/moonshot.json`,
    testFn: (apiKey) => testBearerModels('https://api.moonshot.ai/v1/models', apiKey)
  },
  zhipu: {
    name: 'Zhipu/GLM',
    envKey: 'ZHIPU_API_KEY',
    authProfileProvider: 'zhipu',
    configTemplate: `${TEMPLATES_DIR}/zhipu.json`,
    testFn: (apiKey) => {
      try {
        const r = shell(`curl -s -o /dev/null -w '%{http_code}' -X POST https://open.bigmodel.cn/api/paas/v4/chat/completions \
          -H 'Authorization: Bearer ${apiKey.replace(/'/g, "'\\''")}' \
          -H 'Content-Type: application/json' \
          -d '{"model":"glm-4.5-flash","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}'`, 15000);
        return r === '200';
      } catch { return false; }
    }
  }
};

const CHANNEL_MAP = {
  telegram: { envKey: 'TELEGRAM_BOT_TOKEN', configKey: 'telegram', tokenField: 'botToken' },
  discord:  { envKey: 'DISCORD_BOT_TOKEN',  configKey: 'discord',  tokenField: 'botToken' },
  slack:    { envKey: 'SLACK_BOT_TOKEN',     configKey: 'slack',    tokenField: 'botToken' },
  zalo:     { envKey: 'ZALO_BOT_TOKEN',      configKey: 'zalo',     tokenField: 'botToken' }
};

// --- Docker compose helpers ---
function dockerCompose(cmd, timeout = 60000) {
  return shell(`${COMPOSE_CMD} ${cmd}`, timeout);
}

function dockerExec(cmd, timeout = 30000) {
  return shell(`${COMPOSE_CMD} exec -T openclaw ${cmd}`, timeout);
}

function getContainerStatus() {
  try {
    const out = shell(`docker inspect openclaw --format '{{.State.Status}} {{.State.StartedAt}}' 2>/dev/null`);
    const [status, startedAt] = out.split(' ');
    return { status, startedAt };
  } catch {
    return { status: 'not_found', startedAt: null };
  }
}

function restartContainer(service = 'openclaw') {
  dockerCompose(`up -d ${service}`, 60000);
}

// =============================================================================
// HTTP Server
// =============================================================================
const server = http.createServer(async (req, res) => {
  const ip = getClientIP(req);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // IP Whitelist check
  // if (!ALLOWED_IPS.includes(ip)) {
  //   return json(res, 403, { ok: false, error: 'Access denied' });
  // }

  // Rate limit
  if (isBlocked(ip)) {
    return json(res, 429, { ok: false, error: 'Too many failed attempts. Blocked for 15 minutes.' });
  }

  // =========================================================================
  // PUBLIC ROUTES (no Bearer auth required)
  // =========================================================================

  // GET /login — Serve login page
  if (route(req, 'GET', '/login')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(LOGIN_HTML);
  }

  // POST /api/auth/login — Validate credentials, return gateway token
  if (route(req, 'POST', '/api/auth/login')) {
    try {
      const body = await parseBody(req);
      const { username, password } = body;
      if (!username || !password) {
        return json(res, 400, { ok: false, error: 'Missing username or password' });
      }

      const storedUser = getLoginUser();
      const storedPass = getLoginPass();

      if (!storedUser || !storedPass) {
        return json(res, 503, { ok: false, error: 'Login not configured. Ask admin to create credentials via API.' });
      }

      if (username !== storedUser || !verifyPassword(password, storedPass)) {
        recordFailedAuth(ip);
        return json(res, 401, { ok: false, error: 'Invalid username or password' });
      }

      const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN') || '';
      return json(res, 200, { ok: true, token });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PROTECTED ROUTES (Bearer auth required)
  // =========================================================================

  // Auth
  if (!isAuthorized(req)) {
    recordFailedAuth(ip);
    return json(res, 401, { ok: false, error: 'Invalid or missing API key' });
  }

  let m;

  // =========================================================================
  // POST /api/auth/create-user — Tao login credentials (luu vao .env)
  // =========================================================================
  if (route(req, 'POST', '/api/auth/create-user')) {
    try {
      const body = await parseBody(req);
      const { username, password } = body;
      if (!username || !password) {
        return json(res, 400, { ok: false, error: 'Missing username or password' });
      }
      if (username.length < 3 || username.length > 64) {
        return json(res, 400, { ok: false, error: 'Username must be 3-64 characters' });
      }
      if (password.length < 6) {
        return json(res, 400, { ok: false, error: 'Password must be at least 6 characters' });
      }

      // Only allow 1 user — block if already exists
      const existing = getLoginUser();
      if (existing) {
        return json(res, 409, { ok: false, error: `User '${existing}' already exists. Delete first or use change-password.` });
      }

      const hashed = hashPassword(password);
      setEnvValue('OPENCLAW_LOGIN_USER', username);
      setEnvValue('OPENCLAW_LOGIN_PASS', hashed);

      return json(res, 200, { ok: true, username, message: 'Login credentials saved.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/auth/user — Xoa login credentials
  // =========================================================================
  if (route(req, 'DELETE', '/api/auth/user')) {
    try {
      removeEnvValue('OPENCLAW_LOGIN_USER');
      removeEnvValue('OPENCLAW_LOGIN_PASS');
      return json(res, 200, { ok: true, message: 'Login credentials removed.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/auth/user — Xem login user hien tai
  // =========================================================================
  if (route(req, 'GET', '/api/auth/user')) {
    try {
      const username = getLoginUser();
      return json(res, 200, {
        ok: true,
        configured: !!username,
        username: username || null
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/auth/change-password — Doi password
  // =========================================================================
  if (route(req, 'PUT', '/api/auth/change-password')) {
    try {
      const body = await parseBody(req);
      const { password } = body;
      if (!password || password.length < 6) {
        return json(res, 400, { ok: false, error: 'Password must be at least 6 characters' });
      }

      const username = getLoginUser();
      if (!username) {
        return json(res, 400, { ok: false, error: 'No login user configured. Use POST /api/auth/create-user first.' });
      }

      const hashed = hashPassword(password);
      setEnvValue('OPENCLAW_LOGIN_PASS', hashed);

      return json(res, 200, { ok: true, username, message: 'Password changed.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/info — Thong tin service (tuong tu "Thong tin dang nhap" N8N)
  // =========================================================================
  if (route(req, 'GET', '/api/info')) {
    try {
      const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN') || '';
      const serverIP = getServerIP();
      const { status } = getContainerStatus();
      // Domain from .env; fallback to legacy Caddyfile when .env has no DOMAIN
      const rawDomain = getConfiguredDomainRaw();
      const domain = rawDomain && !/^https?:\/\//.test(rawDomain) ? rawDomain : null;
      const host = rawDomain ? rawDomain.replace(/^https?:\/\//, '') : serverIP;
      const caddyTls = getEnvValue('CADDY_TLS') || '';
      // self-signed = http not applicable; empty CADDY_TLS with domain = Let's Encrypt = https
      const scheme = 'https';

      // Kiem tra DNS domain da tro dung IP chua (dung Cloudflare DoH)
      let dnsStatus = null;
      if (domain && !/^\d+\.\d+\.\d+\.\d+$/.test(domain)) {
        try {
          const out = shell(`curl -sf "https://1.1.1.1/dns-query?name=${domain}&type=A" -H "accept: application/dns-json" 2>/dev/null`, 10000);
          const matches = out.match(/"data":\s*"(\d+\.\d+\.\d+\.\d+)"/g) || [];
          const resolvedIPs = matches.map(m => m.match(/(\d+\.\d+\.\d+\.\d+)/)[1]);
          if (resolvedIPs.includes(serverIP)) {
            dnsStatus = 'ok';
          } else {
            dnsStatus = 'not_pointed';
          }
        } catch {
          dnsStatus = 'unknown';
        }
      }

      // SSL status (derived from .env)
      const sslMode = domain
        ? (caddyTls === 'tls internal' ? 'self-signed' : 'letsencrypt')
        : 'none';

      return json(res, 200, {
        ok: true,
        domain: domain,
        ip: serverIP,
        dashboardUrl: `${scheme}://${host}/#token=${token}`,
        gatewayToken: token,
        mgmtApiKey: sanitizeKey(getMgmtApiKey()),
        status,
        version: getEnvValue('OPENCLAW_VERSION') || 'latest',
        ssl: sslMode,
        dnsStatus,
        ...(dnsStatus === 'not_pointed' ? { dnsWarning: `DNS for ${domain} does not point to ${serverIP}. Update your A record to enable Let's Encrypt SSL.` } : {})
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/status — Trang thai container
  // =========================================================================
  if (route(req, 'GET', '/api/status')) {
    try {
      const { status, startedAt } = getContainerStatus();

      // Caddy status
      let caddyStatus = 'not_found';
      try {
        caddyStatus = shell("docker inspect caddy --format '{{.State.Status}}' 2>/dev/null");
      } catch {}

      return json(res, 200, {
        ok: true,
        openclaw: { status, startedAt },
        caddy: { status: caddyStatus },
        version: getEnvValue('OPENCLAW_VERSION') || 'latest',
        gatewayPort: getEnvValue('OPENCLAW_GATEWAY_PORT') || '18789'
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/domain — Xem domain config
  // =========================================================================
  if (route(req, 'GET', '/api/domain')) {
    try {
      const domain = getConfiguredDomainRaw() || null;
      const caddyTls = getEnvValue('CADDY_TLS') || '';
      const isIP = domain && /^https?:\/\//.test(domain);
      const isDomain = domain && !isIP && domain !== 'localhost';

      return json(res, 200, {
        ok: true,
        domain: isDomain ? domain : null,
        ip: getServerIP(),
        ssl: isDomain && !caddyTls,  // real domain + no explicit TLS = auto Let's Encrypt
        selfSignedSSL: caddyTls === 'tls internal',
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/domain — Doi domain + SSL
  // =========================================================================
  if (route(req, 'PUT', '/api/domain')) {
    try {
      const body = await parseBody(req);
      const domain = (body.domain || '').trim().toLowerCase();
      const email = (body.email || '').trim();

      if (!domain) return json(res, 400, { ok: false, error: 'Missing domain' });
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
        return json(res, 400, { ok: false, error: 'Invalid domain format' });
      }

      // DNS check (Cloudflare DoH)
      const serverIP = getServerIP();
      let resolvedIPs = [];
      try {
        const out = shell(`curl -sf "https://1.1.1.1/dns-query?name=${domain}&type=A" -H "accept: application/dns-json" 2>/dev/null`, 10000);
        const matches = (out || '').match(/"data":\s*"(\d+\.\d+\.\d+\.\d+)"/g) || [];
        resolvedIPs = matches.map(m => m.match(/(\d+\.\d+\.\d+\.\d+)/)[1]);
      } catch {}

      if (resolvedIPs.length === 0) {
        return json(res, 400, { ok: false, error: `Cannot resolve DNS for ${domain}. Point A record to ${serverIP}.` });
      }
      if (!resolvedIPs.includes(serverIP)) {
        return json(res, 400, { ok: false, error: `DNS for ${domain} resolves to ${resolvedIPs.join(', ')} — does not match server IP (${serverIP}).` });
      }

      // Update .env with new domain (Caddy auto Let's Encrypt for real domains)
      setEnvValue('DOMAIN', domain);
      setEnvValue('CADDY_TLS', '');

      // Download latest Caddyfile template from repo
      try {
        shell(`curl -fsSL 'https://raw.githubusercontent.com/tinovn/vps-openclaw-management/main/Caddyfile?t=${Date.now()}' -o '${CADDYFILE}'`, 15000);
      } catch (dlErr) {
        return json(res, 500, { ok: false, error: 'Failed to download Caddyfile: ' + dlErr.message });
      }

      // Restart Caddy container
      try {
        dockerCompose('restart caddy', 30000);
        // Wait and check
        execSync('sleep 3');
        const caddyStatus = shell("docker inspect caddy --format '{{.State.Status}}' 2>/dev/null");
        if (caddyStatus === 'running') {
          return json(res, 200, { ok: true, domain });
        }
      } catch {}

      // Rollback: revert domain to IP in .env
      setEnvValue('DOMAIN', `http://${serverIP}`);
      setEnvValue('CADDY_TLS', '');
      try { dockerCompose('restart caddy', 15000); } catch {}
      return json(res, 500, { ok: false, error: 'Caddy failed to start with this domain. Rolled back to IP config.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/version — Version info
  // =========================================================================
  if (route(req, 'GET', '/api/version')) {
    try {
      let currentImage = 'unknown';
      try {
        currentImage = shell("docker inspect openclaw --format '{{.Config.Image}}' 2>/dev/null");
      } catch {}

      let currentDigest = 'unknown';
      try {
        currentDigest = shell("docker inspect openclaw --format '{{.Image}}' 2>/dev/null");
      } catch {}

      return json(res, 200, {
        ok: true,
        version: getEnvValue('OPENCLAW_VERSION') || 'latest',
        image: currentImage,
        digest: currentDigest
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/upgrade — Pull latest image + recreate
  // =========================================================================
  if (route(req, 'POST', '/api/upgrade')) {
    try {
      exec(`cd ${COMPOSE_DIR} && ${COMPOSE_CMD} pull openclaw && ${COMPOSE_CMD} up -d openclaw`,
        { timeout: 300000 }, (err, stdout, stderr) => {
          console.log('[MGMT] Upgrade completed:', err ? 'FAILED' : 'OK');
          if (stdout) console.log(stdout);
          if (stderr) console.error(stderr);
        });
      return json(res, 202, { ok: true, message: 'Upgrade started. Check /api/status for progress.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/restart — Restart container
  // =========================================================================
  if (route(req, 'POST', '/api/restart')) {
    try {
      restartContainer('openclaw');
      execSync('sleep 2');
      const { status } = getContainerStatus();
      return json(res, 200, { ok: status === 'running', status });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/stop — Stop container
  // =========================================================================
  if (route(req, 'POST', '/api/stop')) {
    try {
      dockerCompose('stop openclaw');
      return json(res, 200, { ok: true, message: 'OpenClaw stopped.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/start — Start container
  // =========================================================================
  if (route(req, 'POST', '/api/start')) {
    try {
      dockerCompose('start openclaw');
      execSync('sleep 2');
      const { status } = getContainerStatus();
      return json(res, 200, { ok: status === 'running', status });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/rebuild — Down + Up (full recreate)
  // =========================================================================
  if (route(req, 'POST', '/api/rebuild')) {
    try {
      dockerCompose('down', 60000);
      dockerCompose('up -d', 120000);
      execSync('sleep 3');
      const { status } = getContainerStatus();
      return json(res, 200, { ok: status === 'running', status });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/reset — Xoa data + config, tao lai tu dau
  // =========================================================================
  if (route(req, 'POST', '/api/reset')) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const confirm = body.confirm;
      if (confirm !== 'RESET') {
        return json(res, 400, { ok: false, error: 'Send {"confirm":"RESET"} to confirm destructive action.' });
      }

      // Down all containers + remove volumes
      dockerCompose('down -v', 60000);

      // Keep .env but reset config and data
      try { execSync(`rm -rf ${CONFIG_DIR}/openclaw.json ${COMPOSE_DIR}/data`); } catch {}
      try { execSync(`mkdir -p ${CONFIG_DIR} ${COMPOSE_DIR}/data`); } catch {}

      // Copy default config
      try { execSync(`cp ${TEMPLATES_DIR}/anthropic.json ${CONFIG_DIR}/openclaw.json`); } catch {}

      // Replace gateway token in config
      const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN') || '';
      if (token) {
        try {
          let config = readConfig();
          config.gateway.auth.token = token;
          writeConfig(config);
        } catch {}
      }

      // Bring everything back up
      dockerCompose('up -d', 120000);
      execSync('sleep 3');
      const { status } = getContainerStatus();

      return json(res, 200, { ok: status === 'running', status, message: 'Reset complete. Config reverted to defaults.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/logs — Container logs
  // =========================================================================
  if (route(req, 'GET', '/api/logs')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const lines = Math.min(Math.max(parseInt(url.searchParams.get('lines')) || 100, 1), 1000);
      const service = url.searchParams.get('service') || 'openclaw';

      const allowed = ['openclaw', 'caddy'];
      if (!allowed.includes(service)) {
        return json(res, 400, { ok: false, error: 'Invalid service. Allowed: ' + allowed.join(', ') });
      }

      const logs = dockerCompose(`logs --tail=${lines} --no-color ${service}`, 15000);
      return json(res, 200, { ok: true, service, lines, logs });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/providers — List tat ca providers (built-in + custom)
  // =========================================================================
  if (route(req, 'GET', '/api/providers')) {
    try {
      const config = readConfig();
      const currentModel = config.agents?.defaults?.model?.primary || '';
      const currentProvider = currentModel.split('/')[0];

      const providers = [];

      // Built-in providers
      for (const [id, p] of Object.entries(PROVIDERS)) {
        const envVal = getEnvValue(p.envKey);
        const profileVal = getAuthProfileApiKey(p.authProfileProvider);
        const val = envVal || profileVal;

        // Read models from template config
        let models = [];
        let defaultModel = null;
        try {
          const tpl = JSON.parse(fs.readFileSync(p.configTemplate, 'utf8'));
          defaultModel = tpl.agents?.defaults?.model?.primary || null;
          const tplProviders = tpl.models?.providers || {};
          for (const prov of Object.values(tplProviders)) {
            if (Array.isArray(prov.models)) models = prov.models;
          }
        } catch {}

        providers.push({
          id,
          name: p.name,
          type: 'built-in',
          active: currentProvider === id || currentProvider === resolveProvider(id),
          defaultModel,
          models,
          apiKey: val ? sanitizeKey(val) : null
        });
      }

      // Custom providers
      const customProviders = config.models?.providers || {};
      for (const [name, p] of Object.entries(customProviders)) {
        if (PROVIDERS[name] || PROVIDERS[resolveProvider(name)]) continue;
        const envKey = `CUSTOM_${name.toUpperCase().replace(/-/g, '_')}_API_KEY`;
        const envVal = getEnvValue(envKey);
        const profileVal = getAuthProfileApiKey(name);
        const val = envVal || profileVal;
        providers.push({
          id: name,
          name: name,
          type: 'custom',
          active: currentProvider === name,
          baseUrl: p.baseUrl,
          api: p.api,
          models: p.models || [],
          apiKey: val ? sanitizeKey(val) : null
        });
      }

      return json(res, 200, { ok: true, activeModel: currentModel, providers });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/config — Xem config hien tai
  // =========================================================================
  if (route(req, 'GET', '/api/config')) {
    try {
      const config = readConfig();
      const model = config.agents?.defaults?.model?.primary || 'unknown';
      const providerName = model.split('/')[0];

      const apiKeys = {};
      for (const [id, p] of Object.entries(PROVIDERS)) {
        const envVal = getEnvValue(p.envKey);
        const profileVal = getAuthProfileApiKey(p.authProfileProvider);
        const val = envVal || profileVal;
        apiKeys[id] = val ? sanitizeKey(val) : null;
      }

      // Include custom providers
      const customProviders = config.models?.providers || {};
      for (const [name, p] of Object.entries(customProviders)) {
        if (PROVIDERS[name] || PROVIDERS[resolveProvider(name)]) continue;
        const envKey = `CUSTOM_${name.toUpperCase().replace(/-/g, '_')}_API_KEY`;
        const envVal = getEnvValue(envKey);
        const profileVal = getAuthProfileApiKey(name);
        const val = envVal || profileVal;
        apiKeys[name] = val ? sanitizeKey(val) : null;
      }

      const agentsList = getAgentsList(config);

      return json(res, 200, {
        ok: true,
        provider: providerName,
        model,
        apiKeys,
        agents: agentsList.map(a => ({ id: a.id, name: a.name || a.id, default: !!a.default, model: a.model || null })),
        bindings: getBindings(config),
        config: {
          agents: config.agents,
          channels: config.channels ? Object.fromEntries(
            Object.entries(config.channels).map(([k, v]) => [k, { ...v, botToken: v.botToken ? '***' : undefined }])
          ) : undefined,
          plugins: config.plugins,
          gateway: { ...config.gateway, auth: { token: '***' } },
          browser: config.browser
        }
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/config/provider — Doi provider + model
  // =========================================================================
  if (route(req, 'PUT', '/api/config/provider')) {
    try {
      const body = await parseBody(req);
      const { provider: rawProvider, model } = body;
      const provider = resolveProvider(rawProvider);

      const providerConfig = PROVIDERS[provider];

      // Check if it's a custom provider
      let config;
      try { config = readConfig(); } catch { config = {}; }
      const customProvider = config.models?.providers?.[provider];

      if (!providerConfig && !customProvider) {
        // List available: built-in + custom
        const customNames = Object.keys(config.models?.providers || {}).filter(n => !PROVIDERS[n] && !PROVIDERS[resolveProvider(n)]);
        const all = [...Object.keys(PROVIDERS), ...customNames];
        return json(res, 400, { ok: false, error: 'Invalid provider. Use: ' + all.join(', ') });
      }

      // --- Custom provider: just switch model ---
      if (!providerConfig && customProvider) {
        if (!model) return json(res, 400, { ok: false, error: 'Missing model. Use format: provider/model-id' });

        if (!config.agents) config.agents = { defaults: { model: {} } };
        if (!config.agents.defaults) config.agents.defaults = { model: {} };
        if (!config.agents.defaults.model) config.agents.defaults.model = {};
        config.agents.defaults.model.primary = model.includes('/') ? model : `${provider}/${model}`;

        writeConfig(config);
        restartContainer('openclaw');
        return json(res, 200, { ok: true, provider, model: config.agents.defaults.model.primary });
      }

      // --- Built-in provider ---
      const templatePath = providerConfig.configTemplate;
      if (!fs.existsSync(templatePath)) {
        return json(res, 500, { ok: false, error: `Template config not found: ${templatePath}` });
      }

      const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
      const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN') || '';

      // Update model from template or body
      if (!config.agents) config.agents = template.agents;
      config.agents.defaults.model.primary = model || template.agents.defaults.model.primary;

      // Merge gateway: keep existing settings, ensure auth token is correct
      config.gateway = { ...template.gateway, ...(config.gateway || {}) };
      config.gateway.auth = { token };
      // Deep merge controlUi from template (ensure new required fields are always present)
      config.gateway.controlUi = { ...template.gateway.controlUi, ...(config.gateway.controlUi || {}) };

      // Preserve browser from template if not set
      if (!config.browser) config.browser = template.browser;

      // Copy models section from template (e.g. custom baseUrl for chatgpt proxy)
      // Remove it when switching to a provider that doesn't need it
      // But preserve existing custom providers
      const existingCustom = {};
      if (config.models?.providers) {
        for (const [name, p] of Object.entries(config.models.providers)) {
          if (!PROVIDERS[name] && !PROVIDERS[resolveProvider(name)]) existingCustom[name] = p;
        }
      }

      if (template.models) {
        config.models = template.models;
      } else {
        delete config.models;
      }

      // Restore custom providers
      if (Object.keys(existingCustom).length > 0) {
        if (!config.models) config.models = { mode: 'merge', providers: {} };
        if (!config.models.providers) config.models.providers = {};
        config.models.mode = 'merge';
        Object.assign(config.models.providers, existingCustom);
      }

      // Write auth-profiles.json if there's an API key in env for this provider
      const authProvider = providerConfig.authProfileProvider;
      const existingKey = getEnvValue(providerConfig.envKey);
      if (existingKey) {
        setAuthProfileApiKey(authProvider, existingKey);
      }

      writeConfig(config);
      restartContainer('openclaw');

      return json(res, 200, { ok: true, provider, model: config.agents.defaults.model.primary });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/config/api-key — Doi API key
  // =========================================================================
  if (route(req, 'PUT', '/api/config/api-key')) {
    try {
      const body = await parseBody(req);
      const { provider: rawProvider, apiKey, agentId } = body;
      const provider = resolveProvider(rawProvider);

      const providerConfig = PROVIDERS[provider];
      if (!providerConfig) return json(res, 400, { ok: false, error: 'Invalid provider' });
      if (!apiKey) return json(res, 400, { ok: false, error: 'Missing apiKey' });
      if (agentId && !isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agentId' });

      const targetAgent = agentId || 'main';

      // 1. Set env var (as fallback) — only for default/main agent
      if (!agentId || agentId === 'main') {
        setEnvValue(providerConfig.envKey, apiKey);
      }

      // 2. Write auth-profiles.json for the target agent
      setAuthProfileApiKey(providerConfig.authProfileProvider, apiKey, targetAgent);

      restartContainer('openclaw');

      return json(res, 200, { ok: true, provider, agentId: targetAgent, apiKey: sanitizeKey(apiKey) });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/config/api-key — Xoa API key
  // =========================================================================
  if (route(req, 'DELETE', '/api/config/api-key')) {
    try {
      const body = await parseBody(req);
      const { provider: rawProvider, agentId } = body;
      const provider = resolveProvider(rawProvider);

      const providerConfig = PROVIDERS[provider];
      if (!providerConfig) return json(res, 400, { ok: false, error: 'Invalid provider' });
      if (agentId && !isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agentId' });

      const targetAgent = agentId || 'main';

      // 1. Remove from auth-profiles.json
      removeAgentApiKey(targetAgent, providerConfig.authProfileProvider);

      // 2. Remove env var (only for default/main agent)
      if (!agentId || agentId === 'main') {
        removeEnvValue(providerConfig.envKey);
      }

      restartContainer('openclaw');

      return json(res, 200, { ok: true, provider, agentId: targetAgent, removed: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/config/test-key — Test API key
  // =========================================================================
  if (route(req, 'POST', '/api/config/test-key')) {
    try {
      const body = await parseBody(req);
      const provider = PROVIDERS[resolveProvider(body.provider)];
      if (!provider) return json(res, 400, { ok: false, error: 'Invalid provider' });
      const ok = provider.testFn(body.apiKey);
      return json(res, 200, { ok, error: ok ? null : 'API key invalid or expired' });
    } catch { return json(res, 500, { ok: false, error: 'Error testing API key' }); }
  }

  // =========================================================================
  // POST /api/config/custom-provider — Tao custom provider moi
  // =========================================================================
  if (route(req, 'POST', '/api/config/custom-provider')) {
    try {
      const body = await parseBody(req);
      const { baseUrl, model, modelName, apiKey, api } = body;

      if (!baseUrl || !model || !apiKey) {
        return json(res, 400, { ok: false, error: 'Missing required fields: baseUrl, model, apiKey' });
      }

      // Parse provider/model-id
      const parts = model.split('/');
      if (parts.length < 2) {
        return json(res, 400, { ok: false, error: 'Model must be in format "provider/model-id"' });
      }
      const providerName = parts[0];
      const modelId = parts.slice(1).join('/');

      if (!/^[a-z][a-z0-9-]{0,31}$/.test(providerName)) {
        return json(res, 400, { ok: false, error: 'Invalid provider name. Use lowercase letters, numbers, hyphens.' });
      }

      // Block built-in providers
      if (PROVIDERS[providerName] || PROVIDERS[resolveProvider(providerName)]) {
        return json(res, 400, { ok: false, error: `"${providerName}" is a built-in provider. Use PUT /api/config/provider instead.` });
      }

      try { new URL(baseUrl); } catch {
        return json(res, 400, { ok: false, error: 'Invalid baseUrl' });
      }

      let config;
      try { config = readConfig(); } catch { config = {}; }

      // Ensure models section
      if (!config.models) config.models = { mode: 'merge', providers: {} };
      if (!config.models.providers) config.models.providers = {};
      config.models.mode = 'merge';

      const envKey = `CUSTOM_${providerName.toUpperCase().replace(/-/g, '_')}_API_KEY`;

      // Add or update provider
      const existing = config.models.providers[providerName];
      if (existing) {
        existing.baseUrl = baseUrl;
        if (api) existing.api = api;
        const models = existing.models || [];
        if (!models.find(m => m.id === modelId)) {
          models.push({ id: modelId, name: modelName || modelId });
          existing.models = models;
        }
      } else {
        config.models.providers[providerName] = {
          baseUrl,
          apiKey: `\${${envKey}}`,
          api: api || 'openai-completions',
          models: [{ id: modelId, name: modelName || modelId }]
        };
      }

      // Set as primary model
      if (!config.agents) config.agents = { defaults: { model: {} } };
      if (!config.agents.defaults) config.agents.defaults = { model: {} };
      if (!config.agents.defaults.model) config.agents.defaults.model = {};
      config.agents.defaults.model.primary = model;

      writeConfig(config);

      // Save API key
      setEnvValue(envKey, apiKey);
      setAuthProfileApiKey(providerName, apiKey);

      restartContainer('openclaw');

      return json(res, 200, { ok: true, provider: providerName, model, baseUrl, apiKey: sanitizeKey(apiKey) });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/config/custom-providers — List custom providers
  // =========================================================================
  if (route(req, 'GET', '/api/config/custom-providers')) {
    try {
      let config;
      try { config = readConfig(); } catch { config = {}; }

      const customProviders = {};
      const providers = config.models?.providers || {};
      for (const [name, p] of Object.entries(providers)) {
        if (PROVIDERS[name] || PROVIDERS[resolveProvider(name)]) continue;

        const envKey = `CUSTOM_${name.toUpperCase().replace(/-/g, '_')}_API_KEY`;
        const envVal = getEnvValue(envKey);
        const profileVal = getAuthProfileApiKey(name);
        const keyVal = envVal || profileVal;

        customProviders[name] = {
          baseUrl: p.baseUrl,
          api: p.api,
          models: p.models || [],
          apiKey: keyVal ? sanitizeKey(keyVal) : null
        };
      }

      const currentModel = config.agents?.defaults?.model?.primary || '';
      const currentProvider = currentModel.split('/')[0];

      return json(res, 200, { ok: true, providers: customProviders, activeProvider: currentProvider, activeModel: currentModel });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/config/custom-provider/:provider — Update custom provider
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/config/custom-provider/:provider'))) {
    try {
      const providerName = m.params.provider;
      const body = await parseBody(req);

      if (PROVIDERS[providerName] || PROVIDERS[resolveProvider(providerName)]) {
        return json(res, 400, { ok: false, error: `"${providerName}" is a built-in provider.` });
      }

      let config;
      try { config = readConfig(); } catch { config = {}; }

      if (!config.models?.providers?.[providerName]) {
        return json(res, 404, { ok: false, error: `Custom provider "${providerName}" not found` });
      }

      const p = config.models.providers[providerName];

      if (body.baseUrl) {
        try { new URL(body.baseUrl); } catch {
          return json(res, 400, { ok: false, error: 'Invalid baseUrl' });
        }
        p.baseUrl = body.baseUrl;
      }
      if (body.api) p.api = body.api;

      // Add model if provided
      if (body.model) {
        const modelId = body.model.includes('/') ? body.model.split('/').slice(1).join('/') : body.model;
        if (!p.models) p.models = [];
        if (!p.models.find(m => m.id === modelId)) {
          p.models.push({ id: modelId, name: body.modelName || modelId });
        }
      }

      // Update API key if provided
      if (body.apiKey) {
        const envKey = `CUSTOM_${providerName.toUpperCase().replace(/-/g, '_')}_API_KEY`;
        setEnvValue(envKey, body.apiKey);
        setAuthProfileApiKey(providerName, body.apiKey);
      }

      writeConfig(config);
      restartContainer('openclaw');

      return json(res, 200, { ok: true, provider: providerName, config: { baseUrl: p.baseUrl, api: p.api, models: p.models } });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/config/custom-provider/:provider — Xoa custom provider
  // =========================================================================
  if ((m = route(req, 'DELETE', '/api/config/custom-provider/:provider'))) {
    try {
      const providerName = m.params.provider;

      if (PROVIDERS[providerName] || PROVIDERS[resolveProvider(providerName)]) {
        return json(res, 400, { ok: false, error: `"${providerName}" is a built-in provider. Cannot delete.` });
      }

      let config;
      try { config = readConfig(); } catch { config = {}; }

      if (!config.models?.providers?.[providerName]) {
        return json(res, 404, { ok: false, error: `Custom provider "${providerName}" not found` });
      }

      delete config.models.providers[providerName];

      // Clean up empty models section
      if (Object.keys(config.models.providers).length === 0) {
        delete config.models;
      }

      // If current model uses this provider, fallback to anthropic
      const currentModel = config.agents?.defaults?.model?.primary || '';
      if (currentModel.startsWith(providerName + '/')) {
        config.agents.defaults.model.primary = 'anthropic/claude-sonnet-4-20250514';
      }

      writeConfig(config);

      // Remove env var + auth profile
      const envKey = `CUSTOM_${providerName.toUpperCase().replace(/-/g, '_')}_API_KEY`;
      try { removeEnvValue(envKey); } catch {}
      try { removeAgentApiKey('main', providerName); } catch {}

      restartContainer('openclaw');

      return json(res, 200, { ok: true, provider: providerName, removed: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/channels — List kenh nhan tin
  // =========================================================================
  if (route(req, 'GET', '/api/channels')) {
    try {
      let configChannels = {};
      try { configChannels = readConfig().channels || {}; } catch {}

      const channels = {};
      for (const [name, ch] of Object.entries(CHANNEL_MAP)) {
        const configCh = configChannels[ch.configKey] || {};
        const envVal = getEnvValue(ch.envKey);
        const tokenVal = configCh[ch.tokenField] || envVal;
        channels[name] = {
          configured: !!(tokenVal && configCh.enabled),
          enabled: !!configCh.enabled,
          token: tokenVal ? sanitizeKey(tokenVal) : null
        };
      }
      return json(res, 200, { ok: true, channels });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/channels/:channel — Them/sua token kenh
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/channels/:channel'))) {
    try {
      const body = await parseBody(req);
      const channel = m.params.channel;

      const chConfig = CHANNEL_MAP[channel];
      if (!chConfig) {
        return json(res, 400, { ok: false, error: 'Invalid channel. Use: telegram, discord, slack, zalo' });
      }
      if (!body.token) return json(res, 400, { ok: false, error: 'Missing token' });

      // 1. Set env var (as fallback)
      setEnvValue(chConfig.envKey, body.token);
      if (channel === 'slack' && body.appToken) {
        setEnvValue('SLACK_APP_TOKEN', body.appToken);
      }

      // 2. Write channel config in openclaw.json
      const config = readConfig();
      if (!config.channels) config.channels = {};
      config.channels[chConfig.configKey] = {
        enabled: true,
        [chConfig.tokenField]: body.token,
        dmPolicy: body.dmPolicy || 'open',
        allowFrom: ['*']
      };

      // 3. Enable plugin if needed (telegram is built-in, others need plugin)
      if (['zalo', 'discord', 'slack'].includes(channel)) {
        if (!config.plugins) config.plugins = { entries: {} };
        if (!config.plugins.entries) config.plugins.entries = {};
        config.plugins.entries[channel] = { enabled: true };
      }

      writeConfig(config);
      restartContainer('openclaw');
      return json(res, 200, { ok: true, channel, token: sanitizeKey(body.token) });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/channels/:channel — Xoa kenh
  // =========================================================================
  if ((m = route(req, 'DELETE', '/api/channels/:channel'))) {
    try {
      const channel = m.params.channel;
      const chConfig = CHANNEL_MAP[channel];
      if (!chConfig) return json(res, 400, { ok: false, error: 'Invalid channel' });

      // 1. Remove env var
      removeEnvValue(chConfig.envKey);
      if (channel === 'slack') removeEnvValue('SLACK_APP_TOKEN');

      // 2. Remove channel config from openclaw.json
      try {
        const config = readConfig();
        if (config.channels && config.channels[chConfig.configKey]) {
          delete config.channels[chConfig.configKey];
        }
        if (config.plugins?.entries?.[channel]) {
          delete config.plugins.entries[channel];
        }
        writeConfig(config);
      } catch {}

      restartContainer('openclaw');
      return json(res, 200, { ok: true, channel, removed: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/env — Xem env vars (masked)
  // =========================================================================
  if (route(req, 'GET', '/api/env')) {
    try {
      const env = readEnvFile();
      const result = {};
      const sensitiveKeys = ['TOKEN', 'KEY', 'SECRET', 'PASSWORD'];

      for (const line of env.split('\n')) {
        if (line.startsWith('#') || !line.includes('=')) continue;
        const eqIndex = line.indexOf('=');
        const key = line.substring(0, eqIndex).trim();
        const value = line.substring(eqIndex + 1).trim();
        if (!key) continue;
        const isSensitive = sensitiveKeys.some(s => key.toUpperCase().includes(s));
        result[key] = isSensitive ? sanitizeKey(value) : value;
      }

      return json(res, 200, { ok: true, env: result });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/env/:key — Set env var
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/env/:key'))) {
    try {
      const body = await parseBody(req);
      const key = m.params.key;

      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
        return json(res, 400, { ok: false, error: 'Invalid env key format. Use UPPER_SNAKE_CASE.' });
      }
      if (key === 'OPENCLAW_MGMT_API_KEY') {
        return json(res, 403, { ok: false, error: 'Cannot modify management API key via this endpoint' });
      }
      if (body.value === undefined || body.value === null) {
        return json(res, 400, { ok: false, error: 'Missing value' });
      }

      setEnvValue(key, body.value);

      // Sync gateway token to openclaw.json + recreate Caddy (env_file only read on create)
      if (key === 'OPENCLAW_GATEWAY_TOKEN') {
        try {
          let config = readConfig();
          if (!config.gateway) config.gateway = {};
          if (!config.gateway.auth) config.gateway.auth = {};
          config.gateway.auth.token = body.value;
          writeConfig(config);
        } catch {}
        dockerCompose('up -d --force-recreate caddy', 60000);
      }

      restartContainer('openclaw');
      return json(res, 200, { ok: true, key, applied: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/env/:key — Xoa env var
  // =========================================================================
  if ((m = route(req, 'DELETE', '/api/env/:key'))) {
    try {
      const key = m.params.key;
      const protectedKeys = ['OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_MGMT_API_KEY', 'OPENCLAW_VERSION', 'OPENCLAW_GATEWAY_PORT'];
      if (protectedKeys.includes(key)) {
        return json(res, 403, { ok: false, error: 'Cannot remove protected environment variable' });
      }
      removeEnvValue(key);
      restartContainer('openclaw');
      return json(res, 200, { ok: true, key, removed: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/system — System info
  // =========================================================================
  if (route(req, 'GET', '/api/system')) {
    try {
      let disk = [];
      try {
        disk = shell("df -h / | tail -1 | awk '{print $2,$3,$4,$5}'").split(' ');
      } catch {}

      let osInfo = '';
      try { osInfo = shell('lsb_release -ds 2>/dev/null || head -1 /etc/os-release'); } catch {}

      return json(res, 200, {
        ok: true,
        hostname: os.hostname(),
        ip: getServerIP(),
        os: osInfo,
        uptime: os.uptime(),
        loadAvg: os.loadavg(),
        memory: {
          total: Math.round(os.totalmem() / 1024 / 1024) + 'MB',
          free: Math.round(os.freemem() / 1024 / 1024) + 'MB',
          used: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024) + 'MB'
        },
        disk: {
          total: disk[0] || 'unknown',
          used: disk[1] || 'unknown',
          available: disk[2] || 'unknown',
          usagePercent: disk[3] || 'unknown'
        },
        nodeVersion: process.version,
        dockerVersion: (() => { try { return shell('docker --version'); } catch { return 'unknown'; } })()
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/cli — CLI Proxy (chay lenh CLI trong container)
  // =========================================================================
  if (route(req, 'POST', '/api/cli')) {
    try {
      const body = await parseBody(req);
      const command = (body.command || '').trim();
      if (!command) return json(res, 400, { ok: false, error: 'Missing command' });

      // Sanitize: chi cho phep lenh an toan
      if (/[;&|`$(){}]/.test(command)) {
        return json(res, 400, { ok: false, error: 'Command contains disallowed characters' });
      }

      const output = dockerExec(`node dist/index.js ${command}`, 60000);
      return json(res, 200, { ok: true, output });
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString() : '';
      const stdout = e.stdout ? e.stdout.toString() : '';
      return json(res, 200, { ok: false, output: stdout || stderr || e.message });
    }
  }

  // =========================================================================
  // POST /api/self-update — Tu dong cap nhat Management API + docker-compose + config templates
  // =========================================================================
  if (route(req, 'POST', '/api/self-update')) {
    try {
      const REPO_RAW = 'https://raw.githubusercontent.com/tinovn/vps-openclaw-management/main';
      const MGMT_API_DIR = '/opt/openclaw-mgmt';

      // --- Pre-download migration: extract DOMAIN from old Caddyfile before overwriting ---
      try {
        if (!getEnvValue('DOMAIN')) {
          const oldCaddy = fs.readFileSync(CADDYFILE, 'utf8');
          const dm = oldCaddy.match(/^(\S+)\s*\{/m);
          if (dm && !dm[1].startsWith('{')) {
            setEnvValue('DOMAIN', dm[1]);
            if (oldCaddy.includes('tls internal')) {
              setEnvValue('CADDY_TLS', 'tls internal');
            } else {
              setEnvValue('CADDY_TLS', '');
            }
          }
        }
      } catch {}

      const configTemplates = [
        'anthropic', 'openai', 'gemini',
        'deepseek', 'groq', 'together', 'mistral', 'xai',
        'cerebras', 'sambanova', 'fireworks', 'cohere',
        'yi', 'baichuan', 'stepfun', 'siliconflow', 'novita', 'openrouter',
        'minimax', 'moonshot', 'zhipu'
      ];
      const files = [
        { url: `${REPO_RAW}/management-api/server.js`, dest: `${MGMT_API_DIR}/server.js` },
        { url: `${REPO_RAW}/docker-compose.yml`, dest: `${COMPOSE_DIR}/docker-compose.yml` },
        { url: `${REPO_RAW}/Caddyfile`, dest: `${COMPOSE_DIR}/Caddyfile` },
        ...configTemplates.map(t => ({ url: `${REPO_RAW}/config/${t}.json`, dest: `${TEMPLATES_DIR}/${t}.json` }))
      ];

      const cacheBust = Date.now();
      const results = [];
      for (const f of files) {
        try {
          shell(`curl -fsSL -H 'Cache-Control: no-cache' '${f.url}?t=${cacheBust}' -o '${f.dest}'`, 30000);
          results.push({ file: f.dest, ok: true });
        } catch (e) {
          results.push({ file: f.dest, ok: false, error: e.message });
        }
      }

      const allOk = results.every(r => r.ok);

      // --- Migrate .env: ensure NODE_OPTIONS is set (80% of system RAM) ---
      try {
        if (!getEnvValue('NODE_OPTIONS')) {
          const heapSize = Math.round(os.totalmem() / 1024 / 1024 * 0.8);
          setEnvValue('NODE_OPTIONS', `--max-old-space-size=${heapSize}`);
        }
      } catch {}

      // --- Migrate existing openclaw.json: ensure required gateway settings ---
      try {
        const liveConfig = readConfig();
        let migrated = false;
        if (liveConfig.gateway) {
          if (!liveConfig.gateway.controlUi) {
            liveConfig.gateway.controlUi = { enabled: true, allowInsecureAuth: true, dangerouslyAllowHostHeaderOriginFallback: true, dangerouslyDisableDeviceAuth: true };
            migrated = true;
          } else {
            const ui = liveConfig.gateway.controlUi;
            if (!ui.allowInsecureAuth) { ui.allowInsecureAuth = true; migrated = true; }
            if (!ui.dangerouslyAllowHostHeaderOriginFallback) { ui.dangerouslyAllowHostHeaderOriginFallback = true; migrated = true; }
            if (!ui.dangerouslyDisableDeviceAuth) { ui.dangerouslyDisableDeviceAuth = true; migrated = true; }
          }
        }
        if (migrated) writeConfig(liveConfig);
      } catch {}

      // Apply docker-compose changes
      // (config migration changes mounted volume, gateway only reads config at startup)
      let composeResult = null;
      try {
        composeResult = dockerCompose('up -d --remove-orphans', 120000);
      } catch (e) {
        composeResult = (composeResult || '') + ' ' + e.message;
      }

      // Restart management API service (systemd sẽ tự start lại với code mới)
      // Dùng exec async để response kịp trả về trước khi process bị kill
      if (allOk) {
        json(res, 200, { ok: true, message: 'Update complete. Management API restarting...', files: results, compose: composeResult });
        setTimeout(() => {
          try { execSync('systemctl restart openclaw-mgmt', { timeout: 10000 }); } catch {}
        }, 500);
        return;
      }

      return json(res, 200, { ok: false, message: 'Some files failed to update', files: results });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/agents/:id/api-key — Masked API keys cho agent cu the
  // =========================================================================
  if ((m = route(req, 'GET', '/api/agents/:id/api-key'))) {
    try {
      const agentId = m.params.id;
      if (!isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agent id' });

      const apiKeys = {};
      for (const [pid, p] of Object.entries(PROVIDERS)) {
        const key = getAgentApiKey(agentId, p.authProfileProvider);
        apiKeys[pid] = key ? sanitizeKey(key) : null;
      }

      return json(res, 200, { ok: true, agentId, apiKeys });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/agents/:id/api-key — Set API key cho agent cu the
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/agents/:id/api-key'))) {
    try {
      const agentId = m.params.id;
      if (!isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agent id' });

      const body = await parseBody(req);
      const { provider, apiKey } = body;

      const providerConfig = PROVIDERS[provider];
      if (!providerConfig) return json(res, 400, { ok: false, error: 'Invalid provider' });
      if (!apiKey) return json(res, 400, { ok: false, error: 'Missing apiKey' });

      // Validate agent exists (main always exists)
      if (agentId !== 'main') {
        const config = readConfig();
        const list = getAgentsList(config);
        if (!list.find(a => a.id === agentId))
          return json(res, 404, { ok: false, error: `Agent '${agentId}' not found` });
      }

      setAgentApiKey(agentId, providerConfig.authProfileProvider, apiKey);
      restartContainer('openclaw');

      return json(res, 200, { ok: true, agentId, provider, apiKey: sanitizeKey(apiKey) });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/agents/:id/default — Set agent lam default
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/agents/:id/default'))) {
    try {
      const agentId = m.params.id;
      if (!isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agent id' });

      const config = readConfig();
      ensureAgentsList(config);

      const idx = config.agents.list.findIndex(a => a.id === agentId);
      if (idx === -1) return json(res, 404, { ok: false, error: `Agent '${agentId}' not found` });

      config.agents.list.forEach(a => { delete a.default; });
      config.agents.list[idx].default = true;

      writeConfig(config);
      restartContainer('openclaw');

      return json(res, 200, { ok: true, defaultAgent: agentId });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/agents/:id — Chi tiet agent
  // =========================================================================
  if ((m = route(req, 'GET', '/api/agents/:id'))) {
    try {
      const agentId = m.params.id;
      if (!isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agent id' });

      const config = readConfig();
      const list = getAgentsList(config);
      const agent = list.find(a => a.id === agentId);

      if (!agent && agentId !== 'main')
        return json(res, 404, { ok: false, error: `Agent '${agentId}' not found` });

      const effectiveAgent = agent || { id: 'main', default: true, name: 'Main Agent' };

      const apiKeys = {};
      for (const [pid, p] of Object.entries(PROVIDERS)) {
        const key = getAgentApiKey(agentId, p.authProfileProvider);
        apiKeys[pid] = key ? sanitizeKey(key) : null;
      }

      return json(res, 200, {
        ok: true,
        agent: {
          ...effectiveAgent,
          default: effectiveAgent.id === getDefaultAgentId(config),
          apiKeys,
          hasAuthProfiles: fs.existsSync(getAgentAuthFile(agentId))
        }
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/agents/:id — Update agent config
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/agents/:id'))) {
    try {
      const agentId = m.params.id;
      if (!isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agent id' });

      const body = await parseBody(req);
      const config = readConfig();
      ensureAgentsList(config);

      let agentIdx = config.agents.list.findIndex(a => a.id === agentId);
      if (agentIdx === -1) {
        // If updating "main" and no list exists yet, create it
        if (agentId === 'main' && config.agents.list.length === 0) {
          config.agents.list.push({ id: 'main', default: true });
          agentIdx = 0;
        } else {
          return json(res, 404, { ok: false, error: `Agent '${agentId}' not found` });
        }
      }

      const agent = config.agents.list[agentIdx];
      const updatable = ['name', 'model', 'workspace', 'agentDir'];
      for (const field of updatable) {
        if (body[field] !== undefined) {
          if (body[field] === null) delete agent[field];
          else agent[field] = body[field];
        }
      }

      config.agents.list[agentIdx] = agent;
      writeConfig(config);
      restartContainer('openclaw');

      return json(res, 200, { ok: true, agent });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/agents/:id — Xoa agent
  // =========================================================================
  if ((m = route(req, 'DELETE', '/api/agents/:id'))) {
    try {
      const agentId = m.params.id;
      if (!isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agent id' });

      const body = await parseBody(req).catch(() => ({}));
      const config = readConfig();
      ensureAgentsList(config);

      const list = config.agents.list;
      if (list.length <= 1)
        return json(res, 400, { ok: false, error: 'Cannot delete the last agent' });

      const idx = list.findIndex(a => a.id === agentId);
      if (idx === -1)
        return json(res, 404, { ok: false, error: `Agent '${agentId}' not found` });

      if (list[idx].default)
        return json(res, 400, { ok: false, error: 'Cannot delete default agent. Set another agent as default first.' });

      config.agents.list.splice(idx, 1);

      // Remove bindings for this agent
      if (Array.isArray(config.bindings)) {
        config.bindings = config.bindings.filter(b => b.agentId !== agentId);
      }

      writeConfig(config);

      // Delete data only if explicitly requested
      if (body.deleteData === true) {
        const agentDir = `${CONFIG_DIR}/agents/${agentId}`;
        if (fs.existsSync(agentDir)) fs.rmSync(agentDir, { recursive: true, force: true });
      }

      restartContainer('openclaw');

      return json(res, 200, { ok: true, id: agentId, removed: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/agents — List tat ca agents
  // =========================================================================
  if (route(req, 'GET', '/api/agents')) {
    try {
      const config = readConfig();
      const list = getAgentsList(config);
      const defaultId = getDefaultAgentId(config);

      const agents = list.map(agent => {
        const hasAuth = fs.existsSync(getAgentAuthFile(agent.id));
        const authData = hasAuth ? readAgentAuth(agent.id) : { profiles: {} };
        const profileCount = Object.keys(authData.profiles || {}).length;
        return {
          id: agent.id,
          name: agent.name || agent.id,
          default: agent.id === defaultId,
          model: agent.model || null,
          hasAuthProfiles: hasAuth,
          apiKeyCount: profileCount
        };
      });

      return json(res, 200, { ok: true, agents, count: agents.length });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/agents — Tao agent moi
  // =========================================================================
  if (route(req, 'POST', '/api/agents')) {
    try {
      const body = await parseBody(req);
      const { id, name, model } = body;

      if (!id) return json(res, 400, { ok: false, error: 'Missing agent id' });
      if (!isValidAgentId(id))
        return json(res, 400, { ok: false, error: 'Agent id must match /^[a-z][a-z0-9-]{0,31}$/' });

      const config = readConfig();
      ensureAgentsList(config);

      // If list is empty (fresh install), add "main" as first agent
      if (config.agents.list.length === 0) {
        config.agents.list.push({ id: 'main', default: true, name: 'Main Agent',
          workspace: '~/.openclaw/workspace-main', agentDir: '~/.openclaw/agents/main/agent' });
      }

      if (config.agents.list.find(a => a.id === id))
        return json(res, 409, { ok: false, error: `Agent '${id}' already exists` });

      if (body.default) {
        config.agents.list.forEach(a => { delete a.default; });
      }

      const newAgent = { id };
      if (name) newAgent.name = name;
      if (model) newAgent.model = model;
      if (body.default) newAgent.default = true;
      newAgent.workspace = body.workspace || `~/.openclaw/workspace-${id}`;
      newAgent.agentDir = body.agentDir || `~/.openclaw/agents/${id}/agent`;

      config.agents.list.push(newAgent);

      // Create host directory structure
      const hostDir = getAgentAuthDir(id);
      fs.mkdirSync(hostDir, { recursive: true });
      writeAgentAuth(id, { profiles: {} });

      writeConfig(config);
      restartContainer('openclaw');

      return json(res, 201, { ok: true, agent: newAgent });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/bindings — List routing bindings
  // =========================================================================
  if (route(req, 'GET', '/api/bindings')) {
    try {
      const config = readConfig();
      const bindings = getBindings(config);
      return json(res, 200, { ok: true, bindings, count: bindings.length });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/bindings — Tao binding moi
  // =========================================================================
  if (route(req, 'POST', '/api/bindings')) {
    try {
      const body = await parseBody(req);
      const { agentId, match } = body;

      if (!agentId) return json(res, 400, { ok: false, error: 'Missing agentId' });
      if (!isValidAgentId(agentId)) return json(res, 400, { ok: false, error: 'Invalid agentId' });
      if (!match || typeof match !== 'object')
        return json(res, 400, { ok: false, error: 'Missing or invalid match object' });
      if (!match.channel)
        return json(res, 400, { ok: false, error: 'match.channel is required' });

      const config = readConfig();
      const list = getAgentsList(config);
      if (!list.find(a => a.id === agentId))
        return json(res, 404, { ok: false, error: `Agent '${agentId}' not found` });

      if (!Array.isArray(config.bindings)) config.bindings = [];

      const newBinding = { agentId, match };
      config.bindings.push(newBinding);

      writeConfig(config);
      restartContainer('openclaw');

      return json(res, 201, { ok: true, binding: newBinding, index: config.bindings.length - 1 });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/bindings/:index — Update binding
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/bindings/:index'))) {
    try {
      const index = parseInt(m.params.index);
      const body = await parseBody(req);

      const config = readConfig();
      if (!Array.isArray(config.bindings) || index < 0 || index >= config.bindings.length)
        return json(res, 404, { ok: false, error: `Binding at index ${index} not found` });

      if (body.agentId) {
        if (!isValidAgentId(body.agentId))
          return json(res, 400, { ok: false, error: 'Invalid agentId' });
        const list = getAgentsList(config);
        if (!list.find(a => a.id === body.agentId))
          return json(res, 404, { ok: false, error: `Agent '${body.agentId}' not found` });
        config.bindings[index].agentId = body.agentId;
      }

      if (body.match && typeof body.match === 'object') {
        if (!body.match.channel)
          return json(res, 400, { ok: false, error: 'match.channel is required' });
        config.bindings[index].match = body.match;
      }

      writeConfig(config);
      restartContainer('openclaw');

      return json(res, 200, { ok: true, index, binding: config.bindings[index] });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/bindings/:index — Xoa binding
  // =========================================================================
  if ((m = route(req, 'DELETE', '/api/bindings/:index'))) {
    try {
      const index = parseInt(m.params.index);
      const config = readConfig();

      if (!Array.isArray(config.bindings) || index < 0 || index >= config.bindings.length)
        return json(res, 404, { ok: false, error: `Binding at index ${index} not found` });

      const removed = config.bindings.splice(index, 1)[0];

      writeConfig(config);
      restartContainer('openclaw');

      return json(res, 200, { ok: true, index, removed, remaining: config.bindings.length });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // 404
  // =========================================================================
  json(res, 404, { ok: false, error: 'Not found' });
});

// =============================================================================
// Login HTML Page
// =============================================================================
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenClaw Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e2e8f0}
.card{background:#1e293b;border-radius:16px;padding:40px;width:100%;max-width:400px;box-shadow:0 25px 50px rgba(0,0,0,.4)}
.logo{text-align:center;margin-bottom:32px}
.logo h1{font-size:24px;font-weight:700;color:#f8fafc}
.logo p{font-size:14px;color:#94a3b8;margin-top:4px}
.logo .credit{font-size:12px;color:#64748b;margin-top:6px}
.form-group{margin-bottom:20px}
.form-group label{display:block;font-size:13px;font-weight:500;color:#94a3b8;margin-bottom:6px}
.form-group input{width:100%;padding:12px 16px;background:#0f172a;border:1px solid #334155;border-radius:10px;color:#f8fafc;font-size:15px;outline:none;transition:border-color .2s}
.form-group input:focus{border-color:#3b82f6}
.btn{width:100%;padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;transition:background .2s}
.btn:hover{background:#2563eb}
.btn:disabled{opacity:.5;cursor:not-allowed}
.error{background:#7f1d1d;color:#fca5a5;padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px;display:none}
.spinner{display:inline-block;width:16px;height:16px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle;margin-right:6px}
@keyframes spin{to{transform:rotate(360deg)}}

.copyright{text-align:center;margin-top:12px}
.copyright p{font-size:14px;color:#94a3b8;margin-top:4px}
.copyright .credit{font-size:12px;color:#64748b;margin-top:6px}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <h1>\u{1F980} OpenClaw</h1>
    <p>Sign in to continue</p>
    
  </div>
  <div class="error" id="error"></div>
  <form id="loginForm">
    <div class="form-group">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" autocomplete="username" required autofocus>
    </div>
    <div class="form-group">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>
    </div>
    <button type="submit" class="btn" id="submitBtn">Sign in</button>
  </form>
 <div class="copyright">
  <p class="credit">Make with ❤️ by Tino</p>
</div>
</div>

<script>
const form = document.getElementById('loginForm');
const errorEl = document.getElementById('error');
const btn = document.getElementById('submitBtn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.style.display = 'none';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Signing in...';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value
      })
    });
    const data = await res.json();

    if (data.ok && data.token) {
      window.location.href = '/#token=' + data.token;
    } else {
      errorEl.textContent = data.error || 'Login failed';
      errorEl.style.display = 'block';
    }
  } catch (err) {
    errorEl.textContent = 'Connection error. Please try again.';
    errorEl.style.display = 'block';
  }

  btn.disabled = false;
  btn.textContent = 'Sign in';
});
</script>
</body>
</html>`;

// --- Startup migration: ensure NODE_OPTIONS in .env (80% of system RAM) ---
try {
  if (!getEnvValue('NODE_OPTIONS')) {
    const heapSize = Math.round(os.totalmem() / 1024 / 1024 * 0.8);
    setEnvValue('NODE_OPTIONS', `--max-old-space-size=${heapSize}`);
    console.log(`[Migration] Set NODE_OPTIONS=--max-old-space-size=${heapSize}`);
    try { dockerCompose('up -d openclaw', 60000); } catch {}
  }
} catch {}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Management API] Running on http://0.0.0.0:${PORT}`);
});
