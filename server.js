const express = require('express');
const crypto = require('crypto');
const app = express();

app.use(express.json());

// ===== CONFIG =====
const SB_URL = process.env.SB_URL || 'https://esfnjnxhbfenziudrhqj.supabase.co';
const SB_KEY = process.env.SB_KEY || '';
const PORT = process.env.PORT || 3000;

// ===== VALIDATION CACHE =====
const validationCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos

function getCached(apiKey) {
  const entry = validationCache.get(apiKey);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) {
    validationCache.delete(apiKey);
    return null;
  }
  return entry.result;
}

function setCache(apiKey, result) {
  validationCache.set(apiKey, { result, time: Date.now() });
  if (validationCache.size > 1000) {
    const oldest = validationCache.keys().next().value;
    validationCache.delete(oldest);
  }
}

// ===== HASH HELPER =====
function hashKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

// ===== CORS =====
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ===== HEALTH CHECK =====
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'nexus-auth-proxy' });
});

// ===== HELPER: Chamar Supabase RPC =====
async function callRPC(functionName, params) {
  const response = await fetch(SB_URL + '/rest/v1/rpc/' + functionName, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY
    },
    body: JSON.stringify(params)
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text || 'Resposta inválida' }; }

  return { statusCode: response.status, data, ok: response.ok };
}

// ===== HELPER: Chamar Edge Function =====
async function callEdgeFunction(path, body) {
  const response = await fetch(SB_URL + '/functions/v1/' + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text || 'Resposta inválida' }; }

  return { statusCode: response.status, data, ok: response.ok };
}

// ===== VALIDAÇÃO SEGURA via RPC (SHA-256 hash comparison) =====
async function validateKeyViaRPC(apiKey) {
  const keyHash = hashKey(apiKey);
  const result = await callRPC('validate_api_key', { p_key_hash: keyHash });

  // RPC retorna o JSON diretamente (não wrapped)
  if (result.ok && result.data && result.data.valid === true) {
    return {
      statusCode: 200,
      data: { success: true, remaining: result.data.remaining },
      ok: true
    };
  }

  // Chave inválida
  const errorMsg = (result.data && result.data.error) || 'Chave inválida ou revogada';
  return {
    statusCode: 401,
    data: { error: errorMsg },
    ok: false
  };
}

// ===== AUTH PROXY =====
app.post('/webhook/nexus-auth-proxy', async (req, res) => {
  const { action, api_key, amount } = req.body || {};

  if (!action) {
    return res.status(400).json({ statusCode: 400, data: { error: 'Missing action' }, ok: false });
  }
  if (!api_key) {
    return res.status(400).json({ statusCode: 400, data: { error: 'Missing api_key' }, ok: false });
  }

  // Validação de formato básica
  if (!api_key.startsWith('sk_live_') || api_key.length < 20) {
    return res.status(401).json({ statusCode: 401, data: { error: 'Formato de chave inválido' }, ok: false });
  }

  try {
    // ===== VALIDATE LICENSE (via RPC — NÃO consome créditos) =====
    if (action === 'validate_license') {
      // 1. Checar cache
      const cached = getCached(api_key);
      if (cached) {
        return res.status(cached.statusCode).json(cached);
      }

      // 2. Validar via RPC (compara SHA-256 hash da chave completa)
      const result = await validateKeyViaRPC(api_key);
      setCache(api_key, result);
      return res.status(result.statusCode).json(result);
    }

    // ===== USE CREDITS =====
    if (action === 'use_credits') {
      const creditAmount = parseFloat(amount) || 0;
      if (creditAmount <= 0) {
        return res.status(400).json({ statusCode: 400, data: { error: 'Amount deve ser > 0' }, ok: false });
      }

      // PASSO 1: Validar chave completa via RPC ANTES de consumir
      const validation = await validateKeyViaRPC(api_key);
      if (!validation.ok) {
        return res.status(401).json({ statusCode: 401, data: { error: 'Chave inválida ou revogada' }, ok: false });
      }

      // PASSO 2: Chave válida — consumir créditos via Edge Function
      const result = await callEdgeFunction('use-credits', { api_key, amount: creditAmount });

      // Atualizar cache
      if (result.ok) {
        setCache(api_key, { statusCode: 200, data: { success: true, remaining: result.data.remaining }, ok: true });
      }

      return res.status(result.statusCode).json(result);
    }

    return res.status(400).json({ statusCode: 400, data: { error: 'Invalid action' }, ok: false });
  } catch (err) {
    console.error('[nexus-auth-proxy] Error:', err.message);
    return res.status(502).json({ statusCode: 502, data: { error: 'Erro de conexão com Supabase' }, ok: false });
  }
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`[nexus-auth-proxy] Running on port ${PORT}`);
});
