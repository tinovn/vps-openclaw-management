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

const MAX_AUTH_FAILURES = 10;
const BLOCK_DURATION = 15 * 60 * 1000;
const authAttempts = {};

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

// --- Config file helpers ---
function readConfig() {
  return JSON.parse(fs.readFileSync(`${CONFIG_DIR}/openclaw.json`, 'utf8'));
}

function writeConfig(config) {
  fs.writeFileSync(`${CONFIG_DIR}/openclaw.json`, JSON.stringify(config, null, 2), 'utf8');
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

// --- Provider configs ---
const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
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
    configTemplate: `${TEMPLATES_DIR}/openai.json`,
    testFn: (apiKey) => {
      try {
        const r = shell(`curl -s -o /dev/null -w '%{http_code}' https://api.openai.com/v1/models \
          -H 'Authorization: Bearer ${apiKey.replace(/'/g, "'\\''")}' `, 15000);
        return r === '200';
      } catch { return false; }
    }
  },
  gemini: {
    name: 'Google Gemini',
    envKey: 'GOOGLE_API_KEY',
    configTemplate: `${TEMPLATES_DIR}/gemini.json`,
    testFn: (apiKey) => {
      try {
        const r = shell(`curl -s -o /dev/null -w '%{http_code}' \
          "https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey.replace(/'/g, "'\\''")}"`, 15000);
        return r === '200';
      } catch { return false; }
    }
  }
};

const CHANNEL_MAP = {
  telegram: 'TELEGRAM_BOT_TOKEN',
  discord: 'DISCORD_BOT_TOKEN',
  slack: 'SLACK_BOT_TOKEN',
  zalo: 'ZALO_BOT_TOKEN'
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
  dockerCompose(`restart ${service}`, 60000);
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

  // Rate limit
  if (isBlocked(ip)) {
    return json(res, 429, { ok: false, error: 'Too many failed attempts. Blocked for 15 minutes.' });
  }

  // Auth
  if (!isAuthorized(req)) {
    recordFailedAuth(ip);
    return json(res, 401, { ok: false, error: 'Invalid or missing API key' });
  }

  let m;

  // =========================================================================
  // GET /api/info — Thong tin service (tuong tu "Thong tin dang nhap" N8N)
  // =========================================================================
  if (route(req, 'GET', '/api/info')) {
    try {
      const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN') || '';
      const serverIP = getServerIP();
      const { status } = getContainerStatus();

      // Doc domain tu Caddyfile
      let domain = null;
      try {
        const caddyfile = fs.readFileSync(CADDYFILE, 'utf8');
        const dm = caddyfile.match(/^(\S+)\s*\{/m);
        if (dm && !/^\{/.test(dm[1]) && !/localhost/.test(dm[1])) domain = dm[1];
      } catch {}

      const host = domain || serverIP;
      return json(res, 200, {
        ok: true,
        domain: domain,
        ip: serverIP,
        dashboardUrl: `https://${host}?token=${token}`,
        gatewayToken: token,
        mgmtApiKey: sanitizeKey(getMgmtApiKey()),
        status,
        version: getEnvValue('OPENCLAW_VERSION') || 'latest'
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
      let caddyfile = '';
      try { caddyfile = fs.readFileSync(CADDYFILE, 'utf8'); } catch {}

      const dm = caddyfile.match(/^(\S+)\s*\{/m);
      const currentDomain = dm ? dm[1] : null;
      const isEnvVar = currentDomain && currentDomain.startsWith('{');

      return json(res, 200, {
        ok: true,
        domain: (isEnvVar || !currentDomain) ? null : currentDomain,
        ip: getServerIP(),
        ssl: caddyfile.includes('acme'),
        selfSignedSSL: caddyfile.includes('tls internal') || caddyfile.includes('internal'),
        caddyfile
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

      // DNS check
      const serverIP = getServerIP();
      let resolvedIPs = [];
      try {
        const out = shell(`dig +short A ${domain} 2>/dev/null`, 10000);
        if (out) resolvedIPs = out.split('\n').map(ip => ip.trim()).filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
      } catch {}
      if (resolvedIPs.length === 0) {
        try {
          const out = shell(`host ${domain} 2>/dev/null`, 10000);
          const matches = out.match(/has address (\d+\.\d+\.\d+\.\d+)/g);
          if (matches) resolvedIPs = matches.map(s => s.replace('has address ', ''));
        } catch {}
      }

      if (resolvedIPs.length === 0) {
        return json(res, 400, { ok: false, error: `Cannot resolve DNS for ${domain}. Point A record to ${serverIP}.` });
      }
      if (!resolvedIPs.includes(serverIP)) {
        return json(res, 400, { ok: false, error: `DNS for ${domain} resolves to ${resolvedIPs.join(', ')} — does not match server IP (${serverIP}).` });
      }

      // Write Caddyfile
      const emailLine = email ? `{\n    email ${email}\n}\n\n` : '';
      const caddyConfig = `${emailLine}${domain} {
    tls {
        issuer acme {
            dir https://acme-v02.api.letsencrypt.org/directory
        }
    }
    reverse_proxy openclaw:18789
}
`;
      fs.writeFileSync(CADDYFILE, caddyConfig, 'utf8');

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

      // Rollback
      const fallback = `${serverIP} {\n    tls internal\n    reverse_proxy openclaw:18789\n}\n`;
      fs.writeFileSync(CADDYFILE, fallback, 'utf8');
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
  // GET /api/config — Xem config hien tai
  // =========================================================================
  if (route(req, 'GET', '/api/config')) {
    try {
      const config = readConfig();
      const model = config.agents?.defaults?.model?.primary || 'unknown';
      const providerName = model.split('/')[0];

      const apiKeys = {};
      for (const [id, p] of Object.entries(PROVIDERS)) {
        const val = getEnvValue(p.envKey);
        apiKeys[id] = val ? sanitizeKey(val) : null;
      }

      return json(res, 200, {
        ok: true,
        provider: providerName,
        model,
        apiKeys,
        config: {
          agents: config.agents,
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
      const { provider, model } = body;

      if (!PROVIDERS[provider]) {
        return json(res, 400, { ok: false, error: 'Invalid provider. Use: anthropic, openai, gemini' });
      }

      const templatePath = PROVIDERS[provider].configTemplate;
      if (!fs.existsSync(templatePath)) {
        return json(res, 500, { ok: false, error: `Template config not found: ${templatePath}` });
      }

      const config = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
      const token = getEnvValue('OPENCLAW_GATEWAY_TOKEN') || '';
      config.gateway.auth.token = token;

      if (model) {
        config.agents.defaults.model.primary = model;
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
      const { provider, apiKey } = body;

      if (!PROVIDERS[provider]) return json(res, 400, { ok: false, error: 'Invalid provider' });
      if (!apiKey) return json(res, 400, { ok: false, error: 'Missing apiKey' });

      setEnvValue(PROVIDERS[provider].envKey, apiKey);
      restartContainer('openclaw');

      return json(res, 200, { ok: true, provider, apiKey: sanitizeKey(apiKey) });
    } catch (e) { return json(res, 500, { ok: false, error: e.message }); }
  }

  // =========================================================================
  // POST /api/config/test-key — Test API key
  // =========================================================================
  if (route(req, 'POST', '/api/config/test-key')) {
    try {
      const body = await parseBody(req);
      const provider = PROVIDERS[body.provider];
      if (!provider) return json(res, 400, { ok: false, error: 'Invalid provider' });
      const ok = provider.testFn(body.apiKey);
      return json(res, 200, { ok, error: ok ? null : 'API key invalid or expired' });
    } catch { return json(res, 500, { ok: false, error: 'Error testing API key' }); }
  }

  // =========================================================================
  // GET /api/channels — List kenh nhan tin
  // =========================================================================
  if (route(req, 'GET', '/api/channels')) {
    try {
      const channels = {};
      for (const [name, envKey] of Object.entries(CHANNEL_MAP)) {
        const val = getEnvValue(envKey);
        channels[name] = {
          configured: !!val,
          token: val ? sanitizeKey(val) : null
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

      if (!CHANNEL_MAP[channel]) {
        return json(res, 400, { ok: false, error: 'Invalid channel. Use: telegram, discord, slack, zalo' });
      }
      if (!body.token) return json(res, 400, { ok: false, error: 'Missing token' });

      setEnvValue(CHANNEL_MAP[channel], body.token);
      if (channel === 'slack' && body.appToken) {
        setEnvValue('SLACK_APP_TOKEN', body.appToken);
      }

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
      if (!CHANNEL_MAP[channel]) return json(res, 400, { ok: false, error: 'Invalid channel' });

      removeEnvValue(CHANNEL_MAP[channel]);
      if (channel === 'slack') removeEnvValue('SLACK_APP_TOKEN');

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
      return json(res, 200, { ok: true, key, applied: true, note: 'Restart service for changes to take effect' });
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
  // 404
  // =========================================================================
  json(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Management API] Running on http://0.0.0.0:${PORT}`);
});
