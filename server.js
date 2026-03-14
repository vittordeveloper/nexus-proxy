const express = require('express');
const crypto = require('crypto');
const path = require('path');
const app = express();

// TODAS credenciais DEVEM estar nas env vars do Railway. ZERO fallbacks.
const SB_URL = process.env.SB_URL;
const SB_KEY = process.env.SB_KEY;
const N8N_WEBHOOK = process.env.N8N_WEBHOOK;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PORT = process.env.PORT || 3000;

if (!SB_URL || !SB_KEY || !ADMIN_PASSWORD) {
  console.error('[FATAL] Variáveis obrigatórias não configuradas: SB_URL, SB_KEY, ADMIN_PASSWORD');
  process.exit(1);
}

// ===== RATE LIMITING (em memória) =====
const rateLimits = {};
function rateLimit(key, maxReqs, windowMs) {
  const now = Date.now();
  if (!rateLimits[key]) rateLimits[key] = [];
  rateLimits[key] = rateLimits[key].filter(t => now - t < windowMs);
  if (rateLimits[key].length >= maxReqs) return false;
  rateLimits[key].push(now);
  return true;
}
// Limpar entries antigas a cada 5 min
setInterval(() => {
  const now = Date.now();
  for (const k of Object.keys(rateLimits)) {
    rateLimits[k] = rateLimits[k].filter(t => now - t < 300000);
    if (rateLimits[k].length === 0) delete rateLimits[k];
  }
}, 300000);

// Admin login lockout
const adminFailures = {};

app.use(express.json({ limit: '10mb' }));

// ===== CORS =====
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ===== HELPERS =====

async function callRPC(name, params) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`
    },
    body: JSON.stringify(params)
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { error: text || 'Resposta inválida' }; }
}

function adminAuth(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
  // Lockout: 5 falhas = bloqueio por 15 min
  const fail = adminFailures[ip];
  if (fail && fail.count >= 5 && (Date.now() - fail.last) < 900000) {
    return res.status(429).json({ error: 'Muitas tentativas. Tente novamente em 15 minutos.' });
  }
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${ADMIN_PASSWORD}`) {
    if (!adminFailures[ip]) adminFailures[ip] = { count: 0, last: 0 };
    adminFailures[ip].count++;
    adminFailures[ip].last = Date.now();
    return res.status(401).json({ error: 'Não autorizado' });
  }
  // Login OK — resetar falhas
  delete adminFailures[ip];
  next();
}

function generateApiKey() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(32);
  let key = 'sk_live_';
  for (let i = 0; i < 32; i++) key += chars[bytes[i] % chars.length];
  return key;
}

// ===== HEALTH =====
app.get('/', (req, res) => res.json({ status: 'ok', service: 'nexus-proxy' }));

// ============================================================
// EXTENSION ENDPOINTS
// ============================================================

// Validate key (sem gastar créditos) — rate limit: 10 req/min por IP
app.post('/api/validate', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
  if (!rateLimit('val:' + ip, 10, 60000)) {
    return res.status(429).json({ success: false, error: 'Muitas requisições. Aguarde.' });
  }
  const { api_key } = req.body || {};
  if (!api_key) return res.status(400).json({ success: false, error: 'Chave não fornecida' });

  try {
    const result = await callRPC('nexus_validate_key', { p_key: api_key });
    if (result && result.valid === true) {
      return res.json({ success: true, remaining: result.credits });
    }
    return res.status(401).json({ success: false, error: (result && result.error) || 'Chave inválida' });
  } catch (e) {
    console.error('[validate]', e.message);
    return res.status(502).json({ success: false, error: 'Erro de conexão' });
  }
});

// Send message (validar + descontar créditos + encaminhar pro n8n)
app.post('/api/send', async (req, res) => {
  const { api_key, message, token, projectId, images, creditAmount } = req.body || {};
  if (!api_key) return res.status(400).json({ success: false, error: 'Chave não fornecida' });
  if (!message) return res.status(400).json({ success: false, error: 'Mensagem não fornecida' });
  if (!token) return res.status(400).json({ success: false, error: 'Token não encontrado. Abra o lovable.dev primeiro.' });
  if (!projectId) return res.status(400).json({ success: false, error: 'Project ID não encontrado. Abra um projeto no lovable.dev.' });

  const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
  if (!rateLimit('send:' + ip, 30, 60000)) {
    return res.status(429).json({ success: false, error: 'Muitas requisições. Aguarde.' });
  }
  const amount = parseFloat(creditAmount) || 0;
  if (amount < 0.4 || amount > 5) {
    return res.status(400).json({ success: false, error: 'Custo de créditos inválido' });
  }

  try {
    // 1. Validar + descontar créditos (atômico)
    const cr = await callRPC('nexus_use_credits', { p_key: api_key, p_amount: amount });
    if (!cr || cr.success !== true) {
      const err = (cr && cr.error) || 'Chave inválida';
      const status = err.includes('insuficientes') ? 402 : 401;
      return res.status(status).json({ success: false, error: err, remaining: (cr && cr.remaining) || 0 });
    }

    // 2. Encaminhar pro n8n
    if (!N8N_WEBHOOK) {
      return res.status(500).json({ success: false, error: 'N8N webhook não configurado', remaining: cr.remaining });
    }

    const n8nBody = { message, token, projectId };
    if (images && images.length > 0) {
      n8nBody.files = images.map((img, i) => ({ data: img, name: `image_${i}.png`, type: 'image/png' }));
    }

    const n8nRes = await fetch(N8N_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(n8nBody)
    });

    let n8nData;
    try { n8nData = await n8nRes.json(); } catch { n8nData = {}; }

    if (!n8nRes.ok) {
      return res.status(502).json({ success: false, error: `Erro n8n: ${n8nRes.status}`, remaining: cr.remaining });
    }

    return res.json({ success: true, data: n8nData, remaining: cr.remaining });
  } catch (e) {
    console.error('[send]', e.message);
    return res.status(502).json({ success: false, error: 'Erro de conexão com o servidor' });
  }
});

// ============================================================
// ADMIN PANEL
// ============================================================

// Servir o painel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Verificar login
app.post('/admin/api/login', adminAuth, (req, res) => {
  res.json({ success: true });
});

// Listar keys
app.get('/admin/api/keys', adminAuth, async (req, res) => {
  try {
    const data = await callRPC('admin_list_keys', {});
    res.json(Array.isArray(data) ? data : []);
  } catch (e) {
    console.error('[admin/keys]', e.message);
    res.status(500).json({ error: 'Erro ao buscar keys' });
  }
});

// Gerar nova key
app.post('/admin/api/keys', adminAuth, async (req, res) => {
  try {
    const { credits, name } = req.body || {};
    const keyValue = generateApiKey();
    const result = await callRPC('admin_create_key', {
      p_key_value: keyValue,
      p_credits: parseInt(credits) || 100,
      p_name: name || ''
    });
    if (result && result.success) {
      res.json({ success: true, key: keyValue, id: result.id });
    } else {
      res.status(500).json({ success: false, error: (result && result.error) || 'Erro ao criar key' });
    }
  } catch (e) {
    console.error('[admin/generate]', e.message);
    res.status(500).json({ success: false, error: 'Erro ao gerar key' });
  }
});

// Revogar key
app.post('/admin/api/keys/revoke', adminAuth, async (req, res) => {
  try {
    res.json(await callRPC('admin_update_key_status', { p_id: req.body.id, p_status: 'revoked' }));
  } catch (e) {
    res.status(500).json({ error: 'Erro ao revogar' });
  }
});

// Ativar key
app.post('/admin/api/keys/activate', adminAuth, async (req, res) => {
  try {
    res.json(await callRPC('admin_update_key_status', { p_id: req.body.id, p_status: 'active' }));
  } catch (e) {
    res.status(500).json({ error: 'Erro ao ativar' });
  }
});

// Adicionar créditos
app.post('/admin/api/keys/add-credits', adminAuth, async (req, res) => {
  try {
    res.json(await callRPC('admin_add_credits', { p_id: req.body.id, p_amount: parseInt(req.body.amount) || 0 }));
  } catch (e) {
    res.status(500).json({ error: 'Erro ao adicionar créditos' });
  }
});

// Deletar key
app.post('/admin/api/keys/delete', adminAuth, async (req, res) => {
  try {
    res.json(await callRPC('admin_delete_key', { p_id: req.body.id }));
  } catch (e) {
    res.status(500).json({ error: 'Erro ao deletar' });
  }
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`[nexus-proxy] Running on port ${PORT}`);
});
