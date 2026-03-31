#!/usr/bin/env node
// =============================================================================
// OpenClaw Management API — Docker Compose based service management
// Auth: Bearer OPENCLAW_MGMT_API_KEY | Port: 9998 | Systemd: openclaw-mgmt.service
// =============================================================================

const http = require('http');
const { execSync, exec, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const PORT = 9998;
const MGMT_VERSION = '2.0.3';
const GITHUB_REPO = 'tinovn/vps-openclaw-management';
const COMPOSE_DIR = '/opt/openclaw';
const OPENCLAW_BIN = 'openclaw';
const OPENCLAW_SERVICE = 'openclaw';
const CADDY_SERVICE = 'caddy';
const CONFIG_DIR = `${COMPOSE_DIR}/config`;
const ENV_FILE = `${COMPOSE_DIR}/.env`;
const CADDYFILE = `${COMPOSE_DIR}/Caddyfile`;
const TEMPLATES_DIR = '/etc/openclaw/config';
const AUTH_PROFILES_DIR = `${CONFIG_DIR}/agents/main/agent`;
const AUTH_PROFILES_FILE = `${AUTH_PROFILES_DIR}/auth-profiles.json`;

// --- GitHub version check (cached) ---
let _latestVersionCache = { version: null, checkedAt: 0 };
const VERSION_CHECK_INTERVAL = 60 * 1000; // 1 minute

// --- ChatGPT OAuth (OpenAI Codex) PKCE sessions ---
const _oauthSessions = {}; // sessionId → { codeVerifier, clientId, agentId, createdAt }
const OAUTH_SESSION_TTL = 10 * 60 * 1000; // 10 minutes
let _oauthClientCache = null;

function getLatestVersion() {
  const now = Date.now();
  if (_latestVersionCache.version && (now - _latestVersionCache.checkedAt) < VERSION_CHECK_INTERVAL) {
    return _latestVersionCache.version;
  }
  try {
    const raw = execSync(
      `curl -sf --max-time 5 "https://api.github.com/repos/${GITHUB_REPO}/contents/version.json?ref=main" -H "Accept: application/vnd.github.v3.raw" 2>/dev/null`,
      { encoding: 'utf8', timeout: 8000 }
    );
    const data = JSON.parse(raw);
    if (data.version) {
      _latestVersionCache = { version: data.version, checkedAt: now };
      return data.version;
    }
  } catch {}
  return _latestVersionCache.version || null;
}

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

// --- Terminal command whitelist ---
function parseTerminalCmd(cmdStr) {
  // Block shell injection metacharacters
  if (/[;&|`$(){}\\!'"<>]/.test(cmdStr)) {
    return { valid: false, error: 'Shell metacharacters not allowed' };
  }
  const parts = cmdStr.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { valid: false, error: 'Empty command' };
  const base = parts[0].toLowerCase();

  // systemctl <action> <service>
  if (base === 'systemctl') {
    const action = parts[1];
    const service = parts[2];
    const allowedActions = ['status', 'restart', 'stop', 'start'];
    const allowedServices = [OPENCLAW_SERVICE, CADDY_SERVICE, 'openclaw-mgmt'];
    if (!action || !allowedActions.includes(action)) {
      return { valid: false, error: 'Allowed: systemctl ' + allowedActions.join('/') + ' ' + allowedServices.join('/') };
    }
    if (!service || !allowedServices.includes(service)) {
      return { valid: false, error: 'Allowed services: ' + allowedServices.join(', ') };
    }
    return { valid: true, argv: ['systemctl', action, service] };
  }

  // journalctl -u <service> [args...]
  if (base === 'journalctl') {
    const allowedServices = [OPENCLAW_SERVICE, CADDY_SERVICE, 'openclaw-mgmt'];
    const uIdx = parts.indexOf('-u');
    const service = uIdx >= 0 ? parts[uIdx + 1] : null;
    if (!service || !allowedServices.includes(service)) {
      return { valid: false, error: 'Usage: journalctl -u ' + allowedServices.join('/') + ' [--no-pager -n 100 | -f]' };
    }
    return { valid: true, argv: parts };
  }

  // openclaw / claw → direct CLI
  if (base === 'openclaw' || base === 'claw') {
    return { valid: true, argv: [OPENCLAW_BIN, ...parts.slice(1)] };
  }

  // npm update -g openclaw
  if (base === 'npm' && parts[1] === 'update' && parts[2] === '-g' && parts[3] === 'openclaw') {
    return { valid: true, argv: ['npm', 'update', '-g', 'openclaw'] };
  }

  // Safe system commands
  const sysMap = {
    'df':       () => ['df', ...(parts.slice(1).length ? parts.slice(1) : ['-h'])],
    'free':     () => ['free', ...(parts.slice(1).length ? parts.slice(1) : ['-h'])],
    'uptime':   () => ['uptime'],
    'date':     () => ['date'],
    'uname':    () => ['uname', '-a'],
    'hostname': () => ['hostname', '-I'],
    'ps':       () => ['ps', 'aux'],
  };
  if (sysMap[base]) return { valid: true, argv: sysMap[base]() };

  return { valid: false, error: 'Command not allowed. Use: systemctl ..., journalctl ..., openclaw ..., npm update -g openclaw, df, free, uptime, ps, date' };
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

// --- Provider aliases ---
const PROVIDER_ALIASES = { gemini: 'google' };
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
    knownModels: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6-20260218', name: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5' },
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku' }
    ],
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
    name: 'OpenAI (API Key)',
    envKey: 'OPENAI_API_KEY',
    authProfileProvider: 'openai',
    configTemplate: `${TEMPLATES_DIR}/openai.json`,
    knownModels: [
      { id: 'gpt-5.4', name: 'GPT-5.4' },
      { id: 'gpt-5.4-pro-2026-03-05', name: 'GPT-5.4 Pro' },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini' },
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano' },
      { id: 'o3', name: 'o3' },
      { id: 'o3-pro', name: 'o3 Pro' },
      { id: 'o3-mini', name: 'o3 Mini' },
      { id: 'o4-mini', name: 'o4-mini' }
    ],
    testFn: (apiKey) => testBearerModels('https://api.openai.com/v1/models', apiKey)
  },
  'openai-codex': {
    name: 'ChatGPT OAuth (Codex)',
    envKey: null,              // No API key — uses OAuth token from auth-profiles.json
    authProfileProvider: 'openai-codex',
    configTemplate: `${TEMPLATES_DIR}/openai-codex.json`,
    oauthOnly: true,           // Requires ChatGPT OAuth, no API key support
    knownModels: [
      { id: 'openai-codex/gpt-5.4',            name: 'GPT-5.4',          default: true },
      { id: 'openai-codex/gpt-5.4-mini',        name: 'GPT-5.4-Mini' },
      { id: 'openai-codex/gpt-5.3-codex',       name: 'GPT-5.3-Codex' },
      { id: 'openai-codex/gpt-5.3-codex-spark', name: 'GPT-5.3-Codex-Spark' },
      { id: 'openai-codex/gpt-5.2-codex',       name: 'GPT-5.2-Codex' },
      { id: 'openai-codex/gpt-5.2',             name: 'GPT-5.2' },
      { id: 'openai-codex/gpt-5.1-codex-max',   name: 'GPT-5.1-Codex-Max' },
      { id: 'openai-codex/gpt-5.1-codex-mini',  name: 'GPT-5.1-Codex-Mini' },
      { id: 'openai-codex/gpt-5.1',             name: 'GPT-5.1' }
    ],
    testFn: () => false  // OAuth token — cannot test with static key
  },
  google: {
    name: 'Google Gemini',
    envKey: 'GEMINI_API_KEY',
    authProfileProvider: 'google',
    configTemplate: `${TEMPLATES_DIR}/google.json`,
    knownModels: [
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' },
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview' },
      { id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash-Lite Preview' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite' }
    ],
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

// =============================================================================
// ChatGPT OAuth (OpenAI Codex) — PKCE OAuth 2.0 Helpers
// Constants extracted from @mariozechner/pi-ai/dist/utils/oauth/openai-codex.js
// =============================================================================
const OPENAI_OAUTH_CLIENT_ID  = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_OAUTH_TOKEN_URL  = 'https://auth.openai.com/oauth/token';
const OPENAI_OAUTH_AUTH_URL   = 'https://auth.openai.com/oauth/authorize';
const OPENAI_OAUTH_REDIRECT   = 'http://localhost:1455/auth/callback';
const OPENAI_OAUTH_SCOPE      = 'openid profile email offline_access';
const OPENAI_OAUTH_PROFILE    = 'openai-codex'; // provider key used by openclaw

function pkceVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// Decode JWT payload to extract accountId / email (no signature verification needed)
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { return null; }
}

// Exchange authorization code for tokens using curl
function exchangeOAuthCode(code, codeVerifier) {
  const tmpFile = `/tmp/openclaw-oauth-${crypto.randomBytes(8).toString('hex')}.dat`;
  try {
    const params = [
      `grant_type=authorization_code`,
      `client_id=${encodeURIComponent(OPENAI_OAUTH_CLIENT_ID)}`,
      `code=${encodeURIComponent(code)}`,
      `code_verifier=${encodeURIComponent(codeVerifier)}`,
      `redirect_uri=${encodeURIComponent(OPENAI_OAUTH_REDIRECT)}`
    ].join('&');
    fs.writeFileSync(tmpFile, params, 'utf8');
    const result = shell(
      `curl -sf --max-time 30 -X POST '${OPENAI_OAUTH_TOKEN_URL}' \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        --data-binary @${tmpFile}`,
      35000
    );
    return JSON.parse(result);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// Store OAuth tokens in auth-profiles.json using openclaw's exact credential format
// Fields: { type, provider, access, refresh, expires (ms), accountId }
// Profile key: "openai-codex:<email|default>"
function storeOAuthTokens(tokens, agentId = 'main') {
  const data = readAgentAuth(agentId);
  data.profiles = data.profiles || {};

  // Extract accountId and email from JWT
  const JWT_CLAIM = 'https://api.openai.com/auth';
  const payload = decodeJwtPayload(tokens.access);
  const accountId = payload?.[JWT_CLAIM]?.chatgpt_account_id || null;
  const email = (typeof payload?.email === 'string' && payload.email.trim()) ? payload.email.trim() : null;

  const profileKey = `${OPENAI_OAUTH_PROFILE}:${email || 'default'}`;

  // Remove any old profile keys for this provider
  for (const k of Object.keys(data.profiles)) {
    if (k.startsWith(`${OPENAI_OAUTH_PROFILE}:`)) delete data.profiles[k];
  }
  // Also remove old incorrect key from previous management API versions
  delete data.profiles['openai:oauth'];

  data.profiles[profileKey] = {
    type: 'oauth',
    provider: OPENAI_OAUTH_PROFILE,
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,  // milliseconds (Date.now() + expires_in*1000)
    accountId
  };
  writeAgentAuth(agentId, data);
  return { profileKey, accountId, email };
}

// Refresh token — returns same shape as exchangeOAuthCode for storeOAuthTokens
function refreshOAuthToken(refreshToken) {
  const tmpFile = `/tmp/openclaw-oauth-refresh-${crypto.randomBytes(8).toString('hex')}.dat`;
  try {
    const params = [
      `grant_type=refresh_token`,
      `client_id=${encodeURIComponent(OPENAI_OAUTH_CLIENT_ID)}`,
      `refresh_token=${encodeURIComponent(refreshToken)}`
    ].join('&');
    fs.writeFileSync(tmpFile, params, 'utf8');
    const result = shell(
      `curl -sf --max-time 30 -X POST '${OPENAI_OAUTH_TOKEN_URL}' \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        --data-binary @${tmpFile}`,
      35000
    );
    const raw = JSON.parse(result);
    // Normalize to openclaw's field format
    if (!raw.access_token) return null;
    return {
      access: raw.access_token,
      refresh: raw.refresh_token,
      expires: typeof raw.expires_in === 'number' ? Date.now() + raw.expires_in * 1000 : null
    };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// Get stored OAuth profile for an agent (searches for openai-codex:* key)
function getOAuthProfile(agentId = 'main') {
  const data = readAgentAuth(agentId);
  const profiles = data.profiles || {};
  for (const [k, v] of Object.entries(profiles)) {
    if (k.startsWith(`${OPENAI_OAUTH_PROFILE}:`) && v && v.access) return { key: k, ...v };
  }
  return null;
}

// Attempt to refresh tokens for a single agent. Returns 'refreshed' | 'skipped' | 'error'
function tryRefreshAgent(agentId) {
  try {
    const profile = getOAuthProfile(agentId);
    if (!profile || !profile.refresh) return 'skipped';

    const now = Date.now();
    // expires is in milliseconds; refresh if < 10 min remaining or expired
    const needsRefresh = !profile.expires || (profile.expires - now) < 600000;
    if (!needsRefresh) return 'skipped';

    const tokens = refreshOAuthToken(profile.refresh);
    if (!tokens || !tokens.access) return 'error';

    storeOAuthTokens(tokens, agentId);
    const remaining = tokens.expires ? Math.round((tokens.expires - Date.now()) / 1000) : '?';
    console.log(`[OAuth] Refreshed token for agent "${agentId}" (expires in ${remaining}s)`);
    return 'refreshed';
  } catch (e) {
    console.error(`[OAuth] Auto-refresh failed for agent "${agentId}": ${e.message}`);
    return 'error';
  }
}

// Cleanup expired OAuth sessions
function pruneOAuthSessions() {
  const now = Date.now();
  for (const id of Object.keys(_oauthSessions)) {
    if (now - _oauthSessions[id].createdAt > OAUTH_SESSION_TTL) delete _oauthSessions[id];
  }
}

// --- Systemd / bare-metal helpers ---
function systemctl(action, service = OPENCLAW_SERVICE, timeout = 30000) {
  return shell(`systemctl ${action} ${service}`, timeout);
}

function openclawExec(cmd, timeout = 30000) {
  return shell(`HOME=${COMPOSE_DIR} ${OPENCLAW_BIN} ${cmd}`, timeout);
}

function getServiceStatus(service = OPENCLAW_SERVICE) {
  try {
    let active;
    try {
      active = shell(`systemctl is-active ${service} 2>/dev/null`).trim();
    } catch (e) {
      // systemctl is-active exits non-zero for inactive/failed states
      const out = e.stdout ? e.stdout.toString().trim() : '';
      active = out || 'inactive';
    }
    let startedAt = null;
    try {
      const ts = shell(`systemctl show ${service} -p ActiveEnterTimestamp --value 2>/dev/null`).trim();
      if (ts) startedAt = new Date(ts).toISOString();
    } catch {}
    const statusMap = { active: 'running', inactive: 'exited', failed: 'exited', activating: 'restarting' };
    return { status: statusMap[active] || active, startedAt };
  } catch {
    return { status: 'not_found', startedAt: null };
  }
}

function restartService(service = OPENCLAW_SERVICE) {
  systemctl('restart', service, 60000);
}

// =============================================================================
// On-demand device auto-approve polling (activated by /pair endpoint)
// Reads/writes device JSON files directly — no CLI/gateway needed
// =============================================================================
const DEVICES_DIR = `${CONFIG_DIR}/devices`;
const PENDING_FILE = `${DEVICES_DIR}/pending.json`;
const PAIRED_FILE = `${DEVICES_DIR}/paired.json`;

let _devicePollUntil = 0;
let _devicePollTimer = null;

function approveAllPendingDevices() {
  try {
    if (!fs.existsSync(PENDING_FILE)) return 0;
    const pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    const keys = Object.keys(pending);
    if (keys.length === 0) return 0;

    let paired = {};
    try { paired = JSON.parse(fs.readFileSync(PAIRED_FILE, 'utf8')); } catch {}

    let approved = 0;
    const now = Date.now();
    for (const key of keys) {
      const device = pending[key];
      const deviceId = device.deviceId || key;
      paired[deviceId] = {
        ...device,
        approvedScopes: device.scopes || [],
        tokens: {
          [device.role || 'operator']: {
            token: crypto.randomBytes(32).toString('base64url'),
            role: device.role || 'operator',
            scopes: device.scopes || [],
            createdAtMs: now
          }
        },
        createdAtMs: device.ts || now,
        approvedAtMs: now
      };
      delete paired[deviceId].requestId;
      delete paired[deviceId].ts;
      delete paired[deviceId].silent;
      delete paired[deviceId].isRepair;
      console.log(`[Devices] Auto-approved: ${deviceId}`);
      approved++;
    }

    if (approved > 0) {
      fs.mkdirSync(DEVICES_DIR, { recursive: true });
      fs.writeFileSync(PAIRED_FILE, JSON.stringify(paired, null, 2), 'utf8');
      fs.writeFileSync(PENDING_FILE, '{}', 'utf8');
    }
    return approved;
  } catch (e) {
    console.error(`[Devices] approve error: ${e.message}`);
    return 0;
  }
}

function startDevicePoll() {
  if (_devicePollTimer) return;
  console.log('[Devices] Polling activated');
  // Approve immediately on first call
  approveAllPendingDevices();
  _devicePollTimer = setInterval(() => {
    if (Date.now() > _devicePollUntil) {
      clearInterval(_devicePollTimer);
      _devicePollTimer = null;
      console.log('[Devices] Polling stopped (timeout)');
      return;
    }
    approveAllPendingDevices();
  }, 5 * 1000);
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

  // GET /pair — Activate device auto-approve + redirect to gateway dashboard
  if (route(req, 'GET', '/pair')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token') || '';
    if (!token) return json(res, 400, { ok: false, error: 'Missing token parameter' });
    _devicePollUntil = Date.now() + 60 * 1000;
    if (!_devicePollTimer) startDevicePoll();
    const rawDomain = (getEnvValue('DOMAIN') || '').trim();
    const domain = (rawDomain && rawDomain !== 'localhost' && !/\s/.test(rawDomain)) ? rawDomain.replace(/^https?:\/\//, '') : null;
    const host = domain || getServerIP();
    const proto = domain ? 'https' : 'http';
    res.writeHead(302, { Location: `${proto}://${host}/#token=${encodeURIComponent(token)}` });
    return res.end();
  }

  // GET /login — Serve login page
  if (route(req, 'GET', '/login')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(LOGIN_HTML);
  }

  // GET /terminal — Serve terminal GUI page (public, auth handled client-side)
  if (route(req, 'GET', '/terminal')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(TERMINAL_HTML);
  }

  // GET /api/terminal/stream — SSE streaming terminal (auth via ?token= query param)
  if (route(req, 'GET', '/api/terminal/stream')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const qToken = (url.searchParams.get('token') || '').trim();
    const expected = getMgmtApiKey();
    let authed = false;
    if (qToken && expected && qToken.length === expected.length) {
      try { authed = crypto.timingSafeEqual(Buffer.from(qToken), Buffer.from(expected)); } catch {}
    }
    if (!authed) {
      recordFailedAuth(ip);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('data: ' + JSON.stringify({ type: 'error', text: 'Unauthorized' }) + '\n\n');
      res.write('data: ' + JSON.stringify({ type: 'exit', code: 1 }) + '\n\n');
      return res.end();
    }

    const cmdStr = (url.searchParams.get('cmd') || '').trim();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    if (!cmdStr) {
      res.write('data: ' + JSON.stringify({ type: 'error', text: 'Missing cmd parameter' }) + '\n\n');
      res.write('data: ' + JSON.stringify({ type: 'exit', code: 1 }) + '\n\n');
      return res.end();
    }

    const parsed = parseTerminalCmd(cmdStr);
    if (!parsed.valid) {
      res.write('data: ' + JSON.stringify({ type: 'error', text: parsed.error }) + '\n\n');
      res.write('data: ' + JSON.stringify({ type: 'exit', code: 1 }) + '\n\n');
      return res.end();
    }

    const proc = spawn(parsed.argv[0], parsed.argv.slice(1), {
      cwd: COMPOSE_DIR,
      env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' },
    });

    let closed = false;
    req.on('close', () => {
      closed = true;
      try { proc.kill('SIGTERM'); } catch {}
    });

    proc.stdout.on('data', chunk => {
      if (!closed) res.write('data: ' + JSON.stringify({ type: 'stdout', text: chunk.toString() }) + '\n\n');
    });

    proc.stderr.on('data', chunk => {
      if (!closed) res.write('data: ' + JSON.stringify({ type: 'stderr', text: chunk.toString() }) + '\n\n');
    });

    proc.on('error', err => {
      if (!closed) {
        res.write('data: ' + JSON.stringify({ type: 'error', text: err.message }) + '\n\n');
        res.write('data: ' + JSON.stringify({ type: 'exit', code: 1 }) + '\n\n');
        res.end();
      }
    });

    proc.on('exit', (code) => {
      if (!closed) {
        res.write('data: ' + JSON.stringify({ type: 'exit', code: code !== null ? code : 0 }) + '\n\n');
        res.end();
      }
    });

    return;
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
      const { status } = getServiceStatus();
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

      const latestVersion = getLatestVersion();

      return json(res, 200, {
        ok: true,
        domain: domain,
        ip: serverIP,
        dashboardUrl: `http://${serverIP}:${PORT}/pair?token=${token}`,
        gatewayToken: token,
        mgmtApiKey: sanitizeKey(getMgmtApiKey()),
        status,
        version: getEnvValue('OPENCLAW_VERSION') || 'latest',
        mgmtVersion: MGMT_VERSION,
        latestMgmtVersion: latestVersion || MGMT_VERSION,
        mgmtUpdateAvailable: latestVersion ? latestVersion !== MGMT_VERSION : false,
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
      const { status, startedAt } = getServiceStatus();

      // Caddy status
      const { status: caddyStatus } = getServiceStatus(CADDY_SERVICE);

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

      // Restart Caddy service
      try {
        systemctl('restart', CADDY_SERVICE, 30000);
        execSync('sleep 3');
        const { status: caddyStatus } = getServiceStatus(CADDY_SERVICE);
        if (caddyStatus === 'running') {
          return json(res, 200, { ok: true, domain });
        }
      } catch {}

      // Rollback: revert domain to IP in .env
      setEnvValue('DOMAIN', `http://${serverIP}`);
      setEnvValue('CADDY_TLS', '');
      try { systemctl('restart', CADDY_SERVICE, 15000); } catch {}
      return json(res, 500, { ok: false, error: 'Caddy failed to start with this domain. Rolled back to IP config.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/version — Version info
  // =========================================================================
  if (route(req, 'GET', '/api/version')) {
    try {
      let clawVersion = 'unknown';
      try {
        clawVersion = shell(`${OPENCLAW_BIN} --version 2>/dev/null`).trim();
      } catch {}

      return json(res, 200, {
        ok: true,
        version: getEnvValue('OPENCLAW_VERSION') || 'latest',
        clawVersion
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/upgrade — Update openclaw + restart
  // =========================================================================
  if (route(req, 'POST', '/api/upgrade')) {
    try {
      exec(`npm update -g openclaw@latest`,
        { timeout: 300000 }, (err, stdout, stderr) => {
          console.log('[MGMT] Upgrade completed:', err ? 'FAILED' : 'OK');
          if (stdout) console.log(stdout);
          if (stderr) console.error(stderr);
          try { execSync(`systemctl restart ${OPENCLAW_SERVICE}`, { timeout: 30000 }); } catch {}
        });
      return json(res, 202, { ok: true, message: 'Upgrade started. Check /api/status for progress.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/restart — Restart container
  // =========================================================================
  if (route(req, 'POST', '/api/restart')) {
    try {
      restartService(OPENCLAW_SERVICE);
      execSync('sleep 2');
      const { status } = getServiceStatus();
      return json(res, 200, { ok: status === 'running', status });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/stop — Stop container
  // =========================================================================
  if (route(req, 'POST', '/api/stop')) {
    try {
      systemctl('stop', OPENCLAW_SERVICE);
      return json(res, 200, { ok: true, message: 'OpenClaw stopped.' });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/start — Start container
  // =========================================================================
  if (route(req, 'POST', '/api/start')) {
    try {
      systemctl('start', OPENCLAW_SERVICE);
      execSync('sleep 2');
      const { status } = getServiceStatus();
      return json(res, 200, { ok: status === 'running', status });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/rebuild — Down + Up (full recreate)
  // =========================================================================
  if (route(req, 'POST', '/api/rebuild')) {
    try {
      restartService(OPENCLAW_SERVICE);
      restartService(CADDY_SERVICE);
      execSync('sleep 3');
      const { status } = getServiceStatus();
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

      // Stop services
      systemctl('stop', OPENCLAW_SERVICE, 60000);

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

      // Start service back up
      systemctl('start', OPENCLAW_SERVICE, 120000);
      execSync('sleep 3');
      const { status } = getServiceStatus();

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

      const allowed = ['openclaw', 'caddy', 'openclaw-mgmt'];
      if (!allowed.includes(service)) {
        return json(res, 400, { ok: false, error: 'Invalid service. Allowed: ' + allowed.join(', ') });
      }

      let logs;
      try {
        logs = shell(`journalctl -u ${service} --no-pager -n ${lines} --no-hostname 2>&1`, 15000);
      } catch (e) {
        logs = e.stdout ? e.stdout.toString().trim() : (e.message || 'No logs available');
      }
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
        const envVal = p.envKey ? getEnvValue(p.envKey) : null;
        const profileVal = getAuthProfileApiKey(p.authProfileProvider);
        const val = envVal || profileVal;

        // Read models from template config
        let tplModels = [];
        let defaultModel = null;
        try {
          const tpl = JSON.parse(fs.readFileSync(p.configTemplate, 'utf8'));
          defaultModel = tpl.agents?.defaults?.model?.primary || null;
          const tplProviders = tpl.models?.providers || {};
          for (const prov of Object.values(tplProviders)) {
            if (Array.isArray(prov.models)) tplModels = prov.models;
          }
        } catch {}

        // Merge: template models + knownModels (deduplicate by id)
        const knownModels = p.knownModels || [];
        const seen = new Set();
        const models = [];
        for (const m of [...tplModels, ...knownModels]) {
          if (!seen.has(m.id)) { seen.add(m.id); models.push(m); }
        }

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

      // Custom providers (from template files)
      try {
        const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));
        for (const file of files) {
          const name = file.replace('.json', '');
          if (PROVIDERS[name] || PROVIDERS[resolveProvider(name)]) continue;
          try {
            const tpl = JSON.parse(fs.readFileSync(`${TEMPLATES_DIR}/${file}`, 'utf8'));
            const provKey = Object.keys(tpl.models?.providers || {})[0];
            if (!provKey) continue;
            const p = tpl.models.providers[provKey];
            const envKey = `CUSTOM_${name.toUpperCase().replace(/-/g, '_')}_API_KEY`;
            const envVal = getEnvValue(envKey);
            const profileVal = getAuthProfileApiKey(name);
            const val = envVal || profileVal;
            providers.push({
              id: name,
              name: name,
              type: 'custom',
              active: currentProvider === name,
              defaultModel: tpl.agents?.defaults?.model?.primary || null,
              baseUrl: p.baseUrl,
              api: p.api,
              models: p.models || [],
              apiKey: val ? sanitizeKey(val) : null
            });
          } catch {}
        }
      } catch {}

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
        if (p.oauthOnly) {
          // OAuth-only provider — show OAuth status instead of API key
          const oauthProfile = getOAuthProfile('main');
          apiKeys[id] = oauthProfile ? 'oauth:active' : null;
        } else {
          const envVal = p.envKey ? getEnvValue(p.envKey) : null;
          const profileVal = getAuthProfileApiKey(p.authProfileProvider);
          const val = envVal || profileVal;
          apiKeys[id] = val ? sanitizeKey(val) : null;
        }
      }

      // Include custom providers (from template files)
      try {
        const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));
        for (const file of files) {
          const name = file.replace('.json', '');
          if (PROVIDERS[name] || PROVIDERS[resolveProvider(name)]) continue;
          const envKey = `CUSTOM_${name.toUpperCase().replace(/-/g, '_')}_API_KEY`;
          const envVal = getEnvValue(envKey);
          const profileVal = getAuthProfileApiKey(name);
          const val = envVal || profileVal;
          apiKeys[name] = val ? sanitizeKey(val) : null;
        }
      } catch {}

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

      // Check if it's a custom provider (from template file)
      let config;
      try { config = readConfig(); } catch { config = {}; }
      const customTplPath = `${TEMPLATES_DIR}/${provider}.json`;
      const hasCustomTemplate = !providerConfig && fs.existsSync(customTplPath);

      if (!providerConfig && !hasCustomTemplate) {
        // List available: built-in + custom from template files
        let customNames = [];
        try {
          customNames = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).filter(n => !PROVIDERS[n] && !PROVIDERS[resolveProvider(n)]);
        } catch {}
        const all = [...Object.keys(PROVIDERS), ...customNames];
        return json(res, 400, { ok: false, error: 'Invalid provider. Use: ' + all.join(', ') });
      }

      // --- Custom provider: load template and switch ---
      if (!providerConfig && hasCustomTemplate) {
        if (!model) return json(res, 400, { ok: false, error: 'Missing model. Use format: provider/model-id' });

        const customTpl = JSON.parse(fs.readFileSync(customTplPath, 'utf8'));
        const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN') || '';

        config.agents = customTpl.agents || config.agents;
        config.agents.defaults.model.primary = model.includes('/') ? model : `${provider}/${model}`;

        // Merge custom provider's models.providers into active config
        if (customTpl.models?.providers) {
          if (!config.models) config.models = { mode: 'merge', providers: {} };
          if (!config.models.providers) config.models.providers = {};
          config.models.mode = 'merge';
          Object.assign(config.models.providers, customTpl.models.providers);
        }

        config.gateway = { ...(customTpl.gateway || {}), ...(config.gateway || {}) };
        config.gateway.auth = { token };
        if (!config.browser) config.browser = customTpl.browser;

        writeConfig(config);
        restartService(OPENCLAW_SERVICE);
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
      // Normalize model prefix (e.g. gemini/model → google/model)
      let finalModel = model || template.agents.defaults.model.primary;
      if (finalModel && finalModel.includes('/')) {
        const [prefix, ...rest] = finalModel.split('/');
        finalModel = `${resolveProvider(prefix)}/${rest.join('/')}`;
      }
      config.agents.defaults.model.primary = finalModel;

      // Merge gateway: keep existing settings, ensure auth token is correct
      config.gateway = { ...template.gateway, ...(config.gateway || {}) };
      config.gateway.auth = { token };
      // Deep merge controlUi from template (ensure new required fields are always present)
      config.gateway.controlUi = { ...template.gateway.controlUi, ...(config.gateway.controlUi || {}) };

      // Preserve browser from template if not set
      if (!config.browser) config.browser = template.browser;

      // Copy models section from template
      // Custom providers are stored in template files, no need to preserve in active config
      if (template.models) {
        config.models = template.models;
      } else {
        delete config.models;
      }

      // Write auth-profiles.json if there's an API key in env for this provider
      // Skip for oauth-only providers (e.g. openai-codex uses OAuth token, not API key)
      if (!providerConfig.oauthOnly) {
        const authProvider = providerConfig.authProfileProvider;
        const existingKey = getEnvValue(providerConfig.envKey);
        if (existingKey) {
          setAuthProfileApiKey(authProvider, existingKey);
        }
      }

      writeConfig(config);
      restartService(OPENCLAW_SERVICE);

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

      restartService(OPENCLAW_SERVICE);

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

      restartService(OPENCLAW_SERVICE);

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
  // POST /api/config/custom-provider — Tao custom provider moi (tao template file)
  // =========================================================================
  if (route(req, 'POST', '/api/config/custom-provider')) {
    try {
      const body = await parseBody(req);
      const { baseUrl, model, modelName, apiKey, api } = body;

      if (!baseUrl || !model || !apiKey) {
        return json(res, 400, { ok: false, error: 'Missing required fields: baseUrl, model, apiKey' });
      }

      const parts = model.split('/');
      if (parts.length < 2) {
        return json(res, 400, { ok: false, error: 'Model must be in format "provider/model-id"' });
      }
      const providerName = parts[0];
      const modelId = parts.slice(1).join('/');

      if (!/^[a-z][a-z0-9-]{0,31}$/.test(providerName)) {
        return json(res, 400, { ok: false, error: 'Invalid provider name. Use lowercase letters, numbers, hyphens.' });
      }

      if (PROVIDERS[providerName] || PROVIDERS[resolveProvider(providerName)]) {
        return json(res, 400, { ok: false, error: `"${providerName}" is a built-in provider. Use PUT /api/config/provider instead.` });
      }

      try { new URL(baseUrl); } catch {
        return json(res, 400, { ok: false, error: 'Invalid baseUrl' });
      }

      const envKey = `CUSTOM_${providerName.toUpperCase().replace(/-/g, '_')}_API_KEY`;
      const tplPath = `${TEMPLATES_DIR}/${providerName}.json`;

      // Create or update template file
      let tpl = {};
      try { tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8')); } catch {}

      // Build template like built-in config
      tpl.agents = { defaults: { model: { primary: model }, maxConcurrent: 4, subagents: { maxConcurrent: 8 } } };
      if (!tpl.models) tpl.models = { mode: 'merge', providers: {} };
      tpl.models.mode = 'merge';
      if (!tpl.models.providers[providerName]) {
        tpl.models.providers[providerName] = {
          baseUrl,
          apiKey: `\${${envKey}}`,
          api: api || 'openai-completions',
          models: [{ id: modelId, name: modelName || modelId }]
        };
      } else {
        const p = tpl.models.providers[providerName];
        p.baseUrl = baseUrl;
        if (api) p.api = api;
        if (!p.models) p.models = [];
        if (!p.models.find(m => m.id === modelId)) {
          p.models.push({ id: modelId, name: modelName || modelId });
        }
      }
      tpl.gateway = { mode: 'local', bind: 'lan', auth: { token: '${OPENCLAW_GATEWAY_TOKEN}' }, trustedProxies: ['127.0.0.1', '::1', '172.16.0.0/12', '10.0.0.0/8', '192.168.0.0/16'], controlUi: { enabled: true, allowInsecureAuth: true, dangerouslyAllowHostHeaderOriginFallback: true, dangerouslyDisableDeviceAuth: false } };
      tpl.browser = { headless: true, defaultProfile: 'openclaw', noSandbox: true };

      fs.writeFileSync(tplPath, JSON.stringify(tpl, null, 2), 'utf8');

      // Save API key
      setEnvValue(envKey, apiKey);
      setAuthProfileApiKey(providerName, apiKey);

      // Switch to this provider (load template into active config)
      const config = readConfig();
      const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN') || '';
      config.agents = tpl.agents;
      config.models = JSON.parse(JSON.stringify(tpl.models));
      config.models.providers[providerName].apiKey = `\${${envKey}}`;
      config.gateway = { ...tpl.gateway, ...(config.gateway || {}) };
      config.gateway.auth = { token };
      if (!config.browser) config.browser = tpl.browser;
      writeConfig(config);

      restartService(OPENCLAW_SERVICE);

      return json(res, 200, { ok: true, provider: providerName, model, baseUrl, apiKey: sanitizeKey(apiKey) });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/config/custom-providers — List custom providers (from template files)
  // =========================================================================
  if (route(req, 'GET', '/api/config/custom-providers')) {
    try {
      const customProviders = {};
      const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const name = file.replace('.json', '');
        if (PROVIDERS[name] || PROVIDERS[resolveProvider(name)]) continue;
        try {
          const tpl = JSON.parse(fs.readFileSync(`${TEMPLATES_DIR}/${file}`, 'utf8'));
          const provKey = Object.keys(tpl.models?.providers || {})[0];
          if (!provKey) continue;
          const p = tpl.models.providers[provKey];
          const envKey = `CUSTOM_${name.toUpperCase().replace(/-/g, '_')}_API_KEY`;
          const keyVal = getEnvValue(envKey) || getAuthProfileApiKey(name);
          customProviders[name] = {
            baseUrl: p.baseUrl,
            api: p.api,
            models: p.models || [],
            apiKey: keyVal ? sanitizeKey(keyVal) : null
          };
        } catch {}
      }

      const config = readConfig();
      const currentModel = config.agents?.defaults?.model?.primary || '';
      const currentProvider = currentModel.split('/')[0];

      return json(res, 200, { ok: true, providers: customProviders, activeProvider: currentProvider, activeModel: currentModel });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // PUT /api/config/custom-provider/:provider — Update custom provider (template file)
  // =========================================================================
  if ((m = route(req, 'PUT', '/api/config/custom-provider/:provider'))) {
    try {
      const providerName = m.params.provider;
      const body = await parseBody(req);

      if (PROVIDERS[providerName] || PROVIDERS[resolveProvider(providerName)]) {
        return json(res, 400, { ok: false, error: `"${providerName}" is a built-in provider.` });
      }

      const tplPath = `${TEMPLATES_DIR}/${providerName}.json`;
      let tpl;
      try { tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8')); } catch {
        return json(res, 404, { ok: false, error: `Custom provider "${providerName}" not found` });
      }

      const provKey = Object.keys(tpl.models?.providers || {})[0];
      if (!provKey) return json(res, 404, { ok: false, error: `Custom provider "${providerName}" has no config` });
      const p = tpl.models.providers[provKey];

      if (body.baseUrl) {
        try { new URL(body.baseUrl); } catch {
          return json(res, 400, { ok: false, error: 'Invalid baseUrl' });
        }
        p.baseUrl = body.baseUrl;
      }
      if (body.api) p.api = body.api;

      if (body.model) {
        const modelId = body.model.includes('/') ? body.model.split('/').slice(1).join('/') : body.model;
        if (!p.models) p.models = [];
        if (!p.models.find(m => m.id === modelId)) {
          p.models.push({ id: modelId, name: body.modelName || modelId });
        }
      }

      if (body.apiKey) {
        const envKey = `CUSTOM_${providerName.toUpperCase().replace(/-/g, '_')}_API_KEY`;
        setEnvValue(envKey, body.apiKey);
        setAuthProfileApiKey(providerName, body.apiKey);
      }

      fs.writeFileSync(tplPath, JSON.stringify(tpl, null, 2), 'utf8');

      // Also update active config if this provider is currently in use
      try {
        const config = readConfig();
        if (config.models?.providers?.[providerName]) {
          config.models.providers[providerName] = { ...p };
          writeConfig(config);
          restartService(OPENCLAW_SERVICE);
        }
      } catch {}

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

      // Check template file exists
      const tplPath = `${TEMPLATES_DIR}/${providerName}.json`;
      if (!fs.existsSync(tplPath)) {
        return json(res, 404, { ok: false, error: `Custom provider "${providerName}" not found` });
      }

      // Delete template file
      fs.unlinkSync(tplPath);

      // Remove from active config if present
      let config;
      try { config = readConfig(); } catch { config = {}; }

      if (config.models?.providers?.[providerName]) {
        delete config.models.providers[providerName];
        if (Object.keys(config.models.providers).length === 0) {
          delete config.models;
        }
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

      restartService(OPENCLAW_SERVICE);

      return json(res, 200, { ok: true, provider: providerName, removed: true });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/providers/:provider/models — Them model vao provider
  // =========================================================================
  if ((m = route(req, 'POST', '/api/providers/:provider/models'))) {
    try {
      const body = await parseBody(req);
      const providerName = m.params.provider;
      const { id: modelId, name: modelName } = body;

      if (!modelId) return json(res, 400, { ok: false, error: 'Missing model id' });

      const config = readConfig();

      // For built-in providers: add to template config file
      if (PROVIDERS[providerName] || PROVIDERS[resolveProvider(providerName)]) {
        const resolved = PROVIDERS[providerName] ? providerName : resolveProvider(providerName);
        const p = PROVIDERS[resolved];
        const tplPath = p.configTemplate;
        let tpl = {};
        try { tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8')); } catch {}
        // Find models array in template (models.providers.<key>.models or knownModels)
        const provKey = Object.keys(tpl.models?.providers || {})[0];
        const modelsList = provKey ? tpl.models.providers[provKey].models : null;
        if (!modelsList) {
          // No models in template — add models section
          if (!tpl.models) tpl.models = { mode: 'merge', providers: {} };
          if (!tpl.models.providers) tpl.models.providers = {};
          if (!tpl.models.providers[resolved]) tpl.models.providers[resolved] = { models: [] };
          tpl.models.providers[resolved].models = [{ id: modelId, name: modelName || modelId }];
        } else {
          if (modelsList.find(m => m.id === modelId)) {
            return json(res, 409, { ok: false, error: `Model "${modelId}" already exists` });
          }
          modelsList.push({ id: modelId, name: modelName || modelId });
        }
        fs.writeFileSync(tplPath, JSON.stringify(tpl, null, 2), 'utf8');
        return json(res, 200, { ok: true, provider: resolved, model: { id: modelId, name: modelName || modelId } });
      }

      // For custom providers: add to template file
      const customTplPath = `${TEMPLATES_DIR}/${providerName}.json`;
      if (!fs.existsSync(customTplPath)) {
        return json(res, 404, { ok: false, error: `Provider "${providerName}" not found` });
      }
      const customTpl = JSON.parse(fs.readFileSync(customTplPath, 'utf8'));
      const provKey = Object.keys(customTpl.models?.providers || {})[0];
      if (!provKey) return json(res, 404, { ok: false, error: `Provider "${providerName}" has no config` });
      const customProv = customTpl.models.providers[provKey];
      if (!customProv.models) customProv.models = [];
      if (customProv.models.find(m => m.id === modelId)) {
        return json(res, 409, { ok: false, error: `Model "${modelId}" already exists` });
      }
      customProv.models.push({ id: modelId, name: modelName || modelId });
      fs.writeFileSync(customTplPath, JSON.stringify(customTpl, null, 2), 'utf8');

      // Also update active config if provider is in use
      if (config.models?.providers?.[providerName]) {
        if (!config.models.providers[providerName].models) config.models.providers[providerName].models = [];
        config.models.providers[providerName].models.push({ id: modelId, name: modelName || modelId });
        writeConfig(config);
      }

      return json(res, 200, { ok: true, provider: providerName, model: { id: modelId, name: modelName || modelId } });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // DELETE /api/providers/:provider/models/:modelId — Xoa model khoi provider
  // =========================================================================
  if ((m = route(req, 'DELETE', '/api/providers/:provider/models/:modelId'))) {
    try {
      const providerName = m.params.provider;
      const modelId = decodeURIComponent(m.params.modelId);

      const config = readConfig();

      // For built-in providers: remove from template config file
      if (PROVIDERS[providerName] || PROVIDERS[resolveProvider(providerName)]) {
        const resolved = PROVIDERS[providerName] ? providerName : resolveProvider(providerName);
        const p = PROVIDERS[resolved];
        const tplPath = p.configTemplate;
        let tpl = {};
        try { tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8')); } catch {}
        const provKey = Object.keys(tpl.models?.providers || {})[0];
        const modelsList = provKey ? tpl.models.providers[provKey].models : null;
        if (!modelsList) return json(res, 404, { ok: false, error: 'No models found for this provider' });
        const idx = modelsList.findIndex(m => m.id === modelId);
        if (idx === -1) return json(res, 404, { ok: false, error: 'Model not found' });
        modelsList.splice(idx, 1);
        fs.writeFileSync(tplPath, JSON.stringify(tpl, null, 2), 'utf8');
        return json(res, 200, { ok: true, provider: resolved, removedModel: modelId });
      }

      // For custom providers: remove from template file
      const customTplPath = `${TEMPLATES_DIR}/${providerName}.json`;
      if (!fs.existsSync(customTplPath)) return json(res, 404, { ok: false, error: `Provider "${providerName}" not found` });
      const customTpl = JSON.parse(fs.readFileSync(customTplPath, 'utf8'));
      const cProvKey = Object.keys(customTpl.models?.providers || {})[0];
      if (!cProvKey) return json(res, 404, { ok: false, error: 'No models found for this provider' });
      const cModels = customTpl.models.providers[cProvKey].models;
      if (!cModels) return json(res, 404, { ok: false, error: 'Model not found' });
      const idx = cModels.findIndex(m => m.id === modelId);
      if (idx === -1) return json(res, 404, { ok: false, error: 'Model not found' });
      cModels.splice(idx, 1);
      fs.writeFileSync(customTplPath, JSON.stringify(customTpl, null, 2), 'utf8');

      // Also update active config if provider is in use
      if (config.models?.providers?.[providerName]?.models) {
        const aIdx = config.models.providers[providerName].models.findIndex(m => m.id === modelId);
        if (aIdx !== -1) {
          config.models.providers[providerName].models.splice(aIdx, 1);
          writeConfig(config);
        }
      }

      return json(res, 200, { ok: true, provider: providerName, removedModel: modelId });
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
      restartService(OPENCLAW_SERVICE);
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

      restartService(OPENCLAW_SERVICE);
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
        restartService(CADDY_SERVICE);
      }

      restartService(OPENCLAW_SERVICE);
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
      restartService(OPENCLAW_SERVICE);
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
        openclawVersion: (() => { try { return shell(`${OPENCLAW_BIN} --version 2>/dev/null`).trim(); } catch { return 'unknown'; } })()
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

      const output = openclawExec(command, 60000);
      return json(res, 200, { ok: true, output });
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString() : '';
      const stdout = e.stdout ? e.stdout.toString() : '';
      return json(res, 200, { ok: false, output: stdout || stderr || e.message });
    }
  }

  // =========================================================================
  // GET /api/devices — List tat ca devices (file I/O, khong spawn CLI)
  // =========================================================================
  if (route(req, 'GET', '/api/devices')) {
    try {
      let pending = {};
      let paired = {};
      try { pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch {}
      try { paired = JSON.parse(fs.readFileSync(PAIRED_FILE, 'utf8')); } catch {}
      return json(res, 200, { ok: true, pending, paired });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // =========================================================================
  // POST /api/devices/approve/:deviceId — Approve mot device (file I/O)
  // =========================================================================
  if (route(req, 'POST', '/api/devices/approve/')) {
    const deviceId = req.url.replace('/api/devices/approve/', '').split('?')[0].trim();
    if (!deviceId) return json(res, 400, { ok: false, error: 'Missing deviceId' });
    if (!/^[a-f0-9\-]{30,70}$/.test(deviceId)) {
      return json(res, 400, { ok: false, error: 'Invalid deviceId format' });
    }
    try {
      let pending = {};
      try { pending = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch {}
      const device = pending[deviceId] || Object.values(pending).find(d => d.deviceId === deviceId);
      if (!device) return json(res, 404, { ok: false, error: 'Device not found in pending' });

      let paired = {};
      try { paired = JSON.parse(fs.readFileSync(PAIRED_FILE, 'utf8')); } catch {}
      const did = device.deviceId || deviceId;
      const now = Date.now();
      paired[did] = {
        ...device,
        approvedScopes: device.scopes || [],
        tokens: {
          [device.role || 'operator']: {
            token: crypto.randomBytes(32).toString('base64url'),
            expiresAtMs: now + 365 * 24 * 60 * 60 * 1000
          }
        },
        createdAtMs: device.ts || now,
        approvedAtMs: now
      };
      delete paired[did].requestId;
      delete paired[did].ts;
      delete paired[did].silent;
      delete paired[did].isRepair;

      // Remove from pending (by key or deviceId)
      for (const key of Object.keys(pending)) {
        if (key === deviceId || (pending[key].deviceId === deviceId)) {
          delete pending[key];
        }
      }

      fs.mkdirSync(DEVICES_DIR, { recursive: true });
      fs.writeFileSync(PAIRED_FILE, JSON.stringify(paired, null, 2), 'utf8');
      fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2), 'utf8');
      return json(res, 200, { ok: true, approved: did });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // =========================================================================
  // POST /api/self-update — Tu dong cap nhat Management API + config templates
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
        'anthropic', 'openai', 'openai-codex', 'google',
        'deepseek', 'groq', 'together', 'mistral', 'xai',
        'cerebras', 'sambanova', 'fireworks', 'cohere',
        'yi', 'baichuan', 'stepfun', 'siliconflow', 'novita', 'openrouter',
        'minimax', 'moonshot', 'zhipu'
      ];
      const files = [
        { url: `${REPO_RAW}/management-api/server.js`, dest: `${MGMT_API_DIR}/server.js` },
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
      // server.js updated successfully = critical part done, restart regardless of template failures
      const serverJsOk = results.find(r => r.file === `${MGMT_API_DIR}/server.js`)?.ok;

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
            liveConfig.gateway.controlUi = { enabled: true, allowInsecureAuth: true, dangerouslyAllowHostHeaderOriginFallback: true, dangerouslyDisableDeviceAuth: false };
            migrated = true;
          } else {
            const ui = liveConfig.gateway.controlUi;
            if (!ui.allowInsecureAuth) { ui.allowInsecureAuth = true; migrated = true; }
            if (!ui.dangerouslyAllowHostHeaderOriginFallback) { ui.dangerouslyAllowHostHeaderOriginFallback = true; migrated = true; }
            if (ui.dangerouslyDisableDeviceAuth === true) { ui.dangerouslyDisableDeviceAuth = false; migrated = true; }
          }
          // Ensure 127.0.0.1 and ::1 in trustedProxies (needed for host network mode)
          const tp = liveConfig.gateway.trustedProxies || [];
          if (!tp.includes('127.0.0.1')) { tp.unshift('127.0.0.1'); migrated = true; }
          if (!tp.includes('::1')) { tp.splice(tp.indexOf('127.0.0.1') + 1, 0, '::1'); migrated = true; }
          liveConfig.gateway.trustedProxies = tp;
          // Ensure allowedOrigins in controlUi includes domain
          const domain = (process.env.DOMAIN || '').replace(/^https?:\/\//, '');
          const ui2 = liveConfig.gateway.controlUi;
          if (ui2) {
            const origins = ui2.allowedOrigins || [];
            const needed = ['http://localhost', 'http://127.0.0.1'];
            if (domain && domain !== 'localhost') {
              needed.unshift(`https://${domain}`, `http://${domain}`);
            }
            for (const o of needed) {
              if (!origins.includes(o)) { origins.push(o); migrated = true; }
            }
            ui2.allowedOrigins = origins;
          }
        }
        if (migrated) writeConfig(liveConfig);
      } catch {}

      // Restart services after config migration
      let restartResult = null;
      try {
        restartService(OPENCLAW_SERVICE);
        restartService(CADDY_SERVICE);
        restartResult = 'ok';
      } catch (e) {
        restartResult = e.message;
      }

      // Restart management API service (systemd sẽ tự start lại với code mới)
      // Dùng exec async để response kịp trả về trước khi process bị kill
      if (serverJsOk) {
        const msg = allOk ? 'Update complete. Management API restarting...' : 'server.js updated (some templates failed). Management API restarting...';
        json(res, 200, { ok: allOk, message: msg, files: results, restart: restartResult });
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
      restartService(OPENCLAW_SERVICE);

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
      restartService(OPENCLAW_SERVICE);

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
      restartService(OPENCLAW_SERVICE);

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

      restartService(OPENCLAW_SERVICE);

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
      restartService(OPENCLAW_SERVICE);

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
      restartService(OPENCLAW_SERVICE);

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
      restartService(OPENCLAW_SERVICE);

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
      restartService(OPENCLAW_SERVICE);

      return json(res, 200, { ok: true, index, removed, remaining: config.bindings.length });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/config/chatgpt-oauth/start — Bat dau ChatGPT OAuth flow
  // Returns: { sessionId, oauthUrl } — user mo oauthUrl trong browser
  // =========================================================================
  if (route(req, 'POST', '/api/config/chatgpt-oauth/start')) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const agentId = (body.agentId && isValidAgentId(body.agentId)) ? body.agentId : 'main';

      const codeVerifier = pkceVerifier();
      const codeChallenge = pkceChallenge(codeVerifier);
      const state = crypto.randomBytes(16).toString('hex');
      const sessionId = crypto.randomBytes(16).toString('hex');

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: OPENAI_OAUTH_CLIENT_ID,
        redirect_uri: OPENAI_OAUTH_REDIRECT,
        scope: OPENAI_OAUTH_SCOPE,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        originator: 'pi'
      });
      const oauthUrl = `${OPENAI_OAUTH_AUTH_URL}?${params.toString()}`;

      pruneOAuthSessions();
      _oauthSessions[sessionId] = { codeVerifier, state, agentId, createdAt: Date.now() };

      const codexModels = PROVIDERS['openai-codex'].knownModels;
      return json(res, 200, {
        ok: true,
        sessionId,
        oauthUrl,
        models: codexModels,
        defaultModel: codexModels.find(m => m.default)?.id || codexModels[0].id,
        instructions: 'Open oauthUrl in browser. After login, copy the full redirect URL (localhost:1455/auth/callback?code=...) and POST to /api/config/chatgpt-oauth/complete with { sessionId, redirectUrl, model? }',
        sessionExpiresIn: OAUTH_SESSION_TTL / 1000
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/config/chatgpt-oauth/complete — Hoan thanh OAuth, luu tokens
  // Body: { sessionId, redirectUrl, model?, switchProvider? }
  // redirectUrl: full localhost:1455/auth/callback?code=...&state=... URL
  // =========================================================================
  if (route(req, 'POST', '/api/config/chatgpt-oauth/complete')) {
    try {
      const body = await parseBody(req);
      const { sessionId, redirectUrl } = body;

      if (!sessionId) return json(res, 400, { ok: false, error: 'Missing sessionId' });
      if (!redirectUrl) return json(res, 400, { ok: false, error: 'Missing redirectUrl' });

      pruneOAuthSessions();
      const session = _oauthSessions[sessionId];
      if (!session) return json(res, 400, { ok: false, error: 'Session not found or expired. Call /start again.' });

      // Parse authorization code (flexible: full URL, code=... query, or raw code)
      let code, returnedState;
      const trimmed = redirectUrl.trim();
      try {
        // Try full URL first
        const u = new URL(trimmed.startsWith('http') ? trimmed : 'http://localhost/?' + trimmed);
        code = u.searchParams.get('code') || undefined;
        returnedState = u.searchParams.get('state') || undefined;
      } catch {
        // Fallback: raw code
        code = trimmed.includes('#') ? trimmed.split('#')[0] : trimmed;
      }
      if (!code) return json(res, 400, { ok: false, error: 'No "code" found in redirectUrl' });

      // Validate state if present
      if (returnedState && returnedState !== session.state) {
        delete _oauthSessions[sessionId];
        return json(res, 400, { ok: false, error: 'State mismatch — possible CSRF. Start a new session.' });
      }

      // Exchange code for tokens
      let raw;
      try {
        raw = exchangeOAuthCode(code, session.codeVerifier);
      } catch (e) {
        return json(res, 502, { ok: false, error: 'Token exchange failed: ' + e.message });
      }
      if (!raw || !raw.access_token) {
        return json(res, 502, { ok: false, error: 'Token exchange failed: no access_token in response', details: raw });
      }

      // Normalize to openclaw's field format (access/refresh/expires in ms)
      const tokens = {
        access: raw.access_token,
        refresh: raw.refresh_token,
        expires: typeof raw.expires_in === 'number' ? Date.now() + raw.expires_in * 1000 : null
      };

      // Store tokens in auth-profiles.json using openclaw's exact format
      const stored = storeOAuthTokens(tokens, session.agentId);
      delete _oauthSessions[sessionId];

      // Switch provider to openai-codex (default: true unless switchProvider=false)
      const shouldSwitch = body.switchProvider !== false;
      let switchedModel = null;
      if (shouldSwitch) {
        try {
          const finalModel = body.model || 'openai-codex/gpt-5.4';
          let config;
          try { config = readConfig(); } catch { config = {}; }
          if (!config.agents) config.agents = { defaults: { model: {}, maxConcurrent: 4, subagents: { maxConcurrent: 8 } } };
          if (!config.agents.defaults) config.agents.defaults = { model: {}, maxConcurrent: 4, subagents: { maxConcurrent: 8 } };
          if (!config.agents.defaults.model) config.agents.defaults.model = {};
          config.agents.defaults.model.primary = finalModel;
          writeConfig(config);
          restartService(OPENCLAW_SERVICE);
          switchedModel = finalModel;
        } catch (e) {
          return json(res, 200, { ok: true, agentId: session.agentId, tokensStored: true, profileKey: stored.profileKey, accountId: stored.accountId, switchedProvider: false, switchError: e.message });
        }
      } else {
        restartService(OPENCLAW_SERVICE);
      }

      return json(res, 200, {
        ok: true,
        agentId: session.agentId,
        tokensStored: true,
        profileKey: stored.profileKey,
        accountId: stored.accountId,
        email: stored.email,
        switchedProvider: shouldSwitch,
        model: switchedModel
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/config/chatgpt-oauth/refresh — Manual refresh token
  // Body: { agentId? }
  // =========================================================================
  if (route(req, 'POST', '/api/config/chatgpt-oauth/refresh')) {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const agentId = (body.agentId && isValidAgentId(body.agentId)) ? body.agentId : 'main';

      const profile = getOAuthProfile(agentId);
      if (!profile) return json(res, 404, { ok: false, error: `No OAuth token found for agent "${agentId}". Complete OAuth flow first.` });
      if (!profile.refresh) return json(res, 400, { ok: false, error: 'No refresh token stored. Must re-authenticate via /start + /complete.' });

      const tokens = refreshOAuthToken(profile.refresh);
      if (!tokens || !tokens.access) {
        return json(res, 502, { ok: false, error: 'Refresh failed: no access_token in response' });
      }

      storeOAuthTokens(tokens, agentId);
      restartService(OPENCLAW_SERVICE);

      const expiresInMs = tokens.expires ? tokens.expires - Date.now() : null;
      return json(res, 200, {
        ok: true,
        agentId,
        expiresIn: expiresInMs ? Math.round(expiresInMs / 1000) : null,
        expiresAt: tokens.expires || null
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // GET /api/config/chatgpt-oauth/status — Xem trang thai OAuth token hien tai
  // =========================================================================
  if (route(req, 'GET', '/api/config/chatgpt-oauth/status')) {
    try {
      const { query } = route(req, 'GET', '/api/config/chatgpt-oauth/status');
      const agentId = (query && query.agentId && isValidAgentId(query.agentId)) ? query.agentId : 'main';
      const profile = getOAuthProfile(agentId);
      pruneOAuthSessions();
      const now = Date.now();
      const expires = profile ? profile.expires : null;
      return json(res, 200, {
        ok: true,
        agentId,
        hasOAuthToken: !!profile,
        profileKey: profile ? profile.key : null,
        accountId: profile ? profile.accountId : null,
        hasRefreshToken: profile ? !!profile.refresh : false,
        expiresAt: expires,
        expiresIn: expires ? Math.max(0, Math.round((expires - now) / 1000)) : null,
        expired: expires ? expires < now : null,
        activeSessions: Object.keys(_oauthSessions).length
      });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // 404
  // =========================================================================
  json(res, 404, { ok: false, error: 'Not found' });
});

// =============================================================================
// Terminal GUI HTML Page
// =============================================================================
const TERMINAL_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>OpenClaw Terminal</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden;background:#0d1117;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
#layout{display:flex;flex-direction:column;height:100vh}
#hdr{display:flex;align-items:center;gap:8px;padding:6px 12px;background:#161b22;border-bottom:1px solid #30363d;flex-shrink:0}
.logo{font-size:15px;font-weight:700;color:#58a6ff;white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:#484f58;flex-shrink:0;transition:background .3s}
.dot.on{background:#3fb950}.dot.off{background:#f85149}
#tw{display:flex;gap:6px;flex:1;min-width:0}
#tok{flex:1;min-width:0;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:5px 10px;font-size:13px;outline:none;font-family:monospace}
#tok:focus{border-color:#58a6ff}
.hb{padding:5px 12px;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;white-space:nowrap;transition:background .15s}
.con{background:#238636;color:#fff}.con:hover{background:#2ea043}
.clr{background:#21262d;color:#8b949e;border:1px solid #30363d}.clr:hover{color:#c9d1d9}
#qbar{display:flex;align-items:center;gap:4px;padding:5px 12px;background:#0d1117;border-bottom:1px solid #21262d;flex-shrink:0;overflow-x:auto;white-space:nowrap}
#qbar::-webkit-scrollbar{height:3px}#qbar::-webkit-scrollbar-thumb{background:#30363d;border-radius:2px}
.ql{font-size:11px;color:#484f58;margin-right:4px}
.qb{padding:3px 9px;background:#161b22;border:1px solid #21262d;border-radius:4px;color:#8b949e;font-size:12px;cursor:pointer;transition:all .15s}
.qb:hover{color:#e6edf3;border-color:#58a6ff}
#tw2{flex:1;overflow:hidden;padding:4px 2px 2px}
.xterm-viewport::-webkit-scrollbar{width:6px}
.xterm-viewport::-webkit-scrollbar-thumb{background:#21262d;border-radius:3px}
</style>
</head>
<body>
<div id="layout">
  <div id="hdr">
    <span class="dot" id="dot"></span>
    <span class="logo">\u{1F980} OpenClaw Terminal</span>
    <div id="tw">
      <input type="password" id="tok" placeholder="Management API Key..." autocomplete="off" spellcheck="false">
      <button class="hb con" onclick="doConnect()">Connect</button>
      <button class="hb clr" onclick="doClear()">Clear</button>
    </div>
  </div>
  <div id="qbar">
    <span class="ql">Quick:</span>
    <button class="qb" onclick="q('systemctl status openclaw')">status</button>
    <button class="qb" onclick="q('journalctl -u openclaw --no-pager -n 80')">logs</button>
    <button class="qb" onclick="q('journalctl -u openclaw -f')">logs -f</button>
    <button class="qb" onclick="q('systemctl restart openclaw')">restart</button>
    <button class="qb" onclick="q('npm update -g openclaw')">upgrade</button>
    <button class="qb" onclick="q('systemctl start openclaw')">start</button>
    <button class="qb" onclick="q('systemctl stop openclaw')">stop</button>
    <button class="qb" onclick="q('df -h')">df</button>
    <button class="qb" onclick="q('free -h')">free</button>
    <button class="qb" onclick="q('uptime')">uptime</button>
    <button class="qb" onclick="q('openclaw models scan')">models scan</button>
    <button class="qb" onclick="q('openclaw channels list')">channels</button>
    <button class="qb" onclick="q('openclaw version')">version</button>
  </div>
  <div id="tw2"><div id="terminal"></div></div>
</div>
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
<script>
var TK='oc_mgmt_token', HK='oc_term_hist';
var term, fit, buf='', hist=[], hidx=-1, running=false, sse=null, tok='', conn=false;
try{hist=JSON.parse(localStorage.getItem(HK)||'[]');}catch(e){}
try{tok=localStorage.getItem(TK)||'';}catch(e){}

function initTerm(){
  term=new Terminal({
    cursorBlink:true,
    fontFamily:'"Cascadia Code","JetBrains Mono","Courier New",monospace',
    fontSize:14,lineHeight:1.3,scrollback:5000,
    theme:{
      background:'#0d1117',foreground:'#c9d1d9',cursor:'#58a6ff',
      selectionBackground:'#264f78',
      black:'#484f58',red:'#f85149',green:'#3fb950',yellow:'#d29922',
      blue:'#58a6ff',magenta:'#bc8cff',cyan:'#76e3ea',white:'#b1bac4',
      brightBlack:'#6e7681',brightRed:'#ff7b72',brightGreen:'#56d364',
      brightYellow:'#e3b341',brightBlue:'#79c0ff',brightMagenta:'#d2a8ff',
      brightCyan:'#87deea',brightWhite:'#f0f6fc'
    }
  });
  fit=new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('terminal'));
  fit.fit();
  window.addEventListener('resize',function(){fit.fit();});
  term.onKey(function(e){handleKey(e.key,e.domEvent);});
}

function handleKey(key,e){
  if(running){
    if(e.ctrlKey&&e.key==='c'){killSSE();term.write('^C\\r\\n');prompt();}
    return;
  }
  if(e.ctrlKey){if(e.key==='l'){term.clear();prompt();}return;}
  if(e.key==='Enter'){
    var cmd=buf.trim();term.write('\\r\\n');buf='';hidx=-1;
    if(cmd){
      if(!hist.length||hist[0]!==cmd){hist.unshift(cmd);if(hist.length>200)hist.pop();try{localStorage.setItem(HK,JSON.stringify(hist));}catch(ex){}}
      execCmd(cmd);
    }else{prompt();}
  }else if(e.key==='Backspace'){
    if(buf.length){buf=buf.slice(0,-1);term.write('\\b \\b');}
  }else if(e.key==='ArrowUp'){
    if(hidx<hist.length-1){hidx++;clearBuf();buf=hist[hidx];term.write(buf);}
  }else if(e.key==='ArrowDown'){
    if(hidx>0){hidx--;clearBuf();buf=hist[hidx];term.write(buf);}
    else if(hidx===0){hidx=-1;clearBuf();}
  }else if(!e.altKey&&!e.metaKey&&key.length===1){buf+=key;term.write(key);}
}

function clearBuf(){if(buf.length)term.write('\\b \\b'.repeat(buf.length));buf='';}
function prompt(){if(conn)term.write('\\x1b[32m$\\x1b[0m ');}

function killSSE(){if(sse){try{sse.close();}catch(e){}sse=null;}running=false;}

function execCmd(cmd){
  if(!conn||!tok){term.write('\\x1b[31mNot connected\\x1b[0m\\r\\n');prompt();return;}
  running=true;
  sse=new EventSource('/api/terminal/stream?cmd='+encodeURIComponent(cmd)+'&token='+encodeURIComponent(tok));
  sse.onmessage=function(ev){
    try{
      var d=JSON.parse(ev.data);
      if(d.type==='stdout')term.write(d.text.replace(/\\n/g,'\\r\\n').replace(/\\r\\r\\n/g,'\\r\\n'));
      else if(d.type==='stderr')term.write('\\x1b[33m'+d.text.replace(/\\n/g,'\\r\\n')+'\\x1b[0m');
      else if(d.type==='error'){term.write('\\x1b[31m'+d.text+'\\x1b[0m\\r\\n');killSSE();prompt();}
      else if(d.type==='exit'){if(d.code)term.write('\\r\\n\\x1b[2m[exit '+d.code+']\\x1b[0m');term.write('\\r\\n');killSSE();prompt();}
    }catch(ex){}
  };
  sse.onerror=function(){term.write('\\r\\n\\x1b[31m[stream error]\\x1b[0m\\r\\n');killSSE();prompt();};
}

function doConnect(){
  var v=document.getElementById('tok').value.trim();
  if(v){tok=v;try{localStorage.setItem(TK,v);}catch(e){}}
  if(!tok){term.write('\\x1b[31mEnter Management API Key\\x1b[0m\\r\\n');return;}
  fetch('/api/status',{headers:{Authorization:'Bearer '+tok}})
    .then(function(r){return r.json();})
    .then(function(d){
      if(d.status||d.ok!==false){
        conn=true;
        document.getElementById('dot').className='dot on';
        term.write('\\x1b[32mConnected!\\x1b[0m  (Ctrl+C = cancel, Ctrl+L = clear)\\r\\n\\r\\n');
        prompt();
      }else{
        term.write('\\x1b[31mAuth failed: '+(d.error||'check your key')+'\\x1b[0m\\r\\n');
        document.getElementById('dot').className='dot off';
      }
    }).catch(function(){
      term.write('\\x1b[31mConnection error\\x1b[0m\\r\\n');
      document.getElementById('dot').className='dot off';
    });
}

function doClear(){if(term){term.clear();if(conn)prompt();}}

function q(cmd){
  if(!conn){term.write('\\x1b[33mConnect first (enter API key + click Connect)\\x1b[0m\\r\\n');return;}
  if(running)killSSE();
  clearBuf();
  term.write('\\x1b[32m$\\x1b[0m '+cmd+'\\r\\n');
  execCmd(cmd);
}

window.addEventListener('DOMContentLoaded',function(){
  initTerm();
  if(tok)document.getElementById('tok').placeholder='Key saved \u2014 click Connect';
  term.write('\\x1b[1;34m OpenClaw Terminal\\x1b[0m\\r\\n');
  term.write('\\x1b[2m \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\\x1b[0m\\r\\n');
  term.write('\\x1b[2m Allowed cmds: systemctl ..., journalctl ..., openclaw ...\\x1b[0m\\r\\n');
  term.write('\\x1b[2m               df, free, uptime, ps, date\\x1b[0m\\r\\n\\r\\n');
  term.write('\\x1b[2m Enter API key above and click Connect\\x1b[0m\\r\\n\\r\\n');
});
</script>
</body>
</html>`;

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
    try { restartService(OPENCLAW_SERVICE); } catch {}
  }
} catch {}

// =============================================================================
// Auto-refresh OAuth tokens background job (runs every 5 minutes)
// =============================================================================
setInterval(() => {
  try {
    // Collect all known agent IDs from config + scan agents dir
    const agentIds = new Set(['main']);
    try {
      const config = JSON.parse(fs.readFileSync(`${CONFIG_DIR}/openclaw.json`, 'utf8'));
      for (const a of (config?.agents?.list || [])) {
        if (a.id) agentIds.add(a.id);
      }
    } catch {}
    try {
      for (const d of fs.readdirSync(`${CONFIG_DIR}/agents`)) agentIds.add(d);
    } catch {}

    let anyRefreshed = false;
    for (const agentId of agentIds) {
      const result = tryRefreshAgent(agentId);
      if (result === 'refreshed') anyRefreshed = true;
    }
    if (anyRefreshed) restartService(OPENCLAW_SERVICE);
  } catch (e) {
    console.error(`[OAuth] Auto-refresh job error: ${e.message}`);
  }
}, 5 * 60 * 1000);


server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Management API] Running on http://0.0.0.0:${PORT}`);
});
