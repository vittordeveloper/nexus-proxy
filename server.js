const express = require('express');
const app = express();

app.use(express.json({ limit: '10mb' }));

// ===== CONFIG =====
const SB_URL = process.env.SB_URL || 'https://esfnjnxhbfenziudrhqj.supabase.co';
const SB_KEY = process.env.SB_KEY || '';
const N8N_WEBHOOK = process.env.N8N_WEBHOOK || '';
const PORT = process.env.PORT || 3000;

// ===== CORS =====
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ===== HEALTH CHECK =====
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'nexus-proxy' });
});

// ===== HELPER: Chamar Supabase RPC =====
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

// ===== POST /api/validate — validar chave (sem gastar créditos) =====
app.post('/api/validate', async (req, res) => {
  const { api_key } = req.body || {};
  if (!api_key) {
    return res.status(400).json({ success: false, error: 'Chave não fornecida' });
  }

  try {
    const result = await callRPC('nexus_validate_key', { p_key: api_key });

    if (result && result.valid === true) {
      return res.json({ success: true, remaining: result.remaining });
    }

    return res.status(401).json({ success: false, error: (result && result.error) || 'Chave inválida ou revogada' });
  } catch (e) {
    console.error('[validate] Error:', e.message);
    return res.status(502).json({ success: false, error: 'Erro de conexão com Supabase' });
  }
});

// ===== POST /api/send — validar + descontar créditos + encaminhar pro n8n =====
app.post('/api/send', async (req, res) => {
  const { api_key, message, token, projectId, images, creditAmount } = req.body || {};

  if (!api_key) return res.status(400).json({ success: false, error: 'Chave não fornecida' });
  if (!message) return res.status(400).json({ success: false, error: 'Mensagem não fornecida' });
  if (!token) return res.status(400).json({ success: false, error: 'Token não encontrado. Abra o lovable.dev primeiro.' });
  if (!projectId) return res.status(400).json({ success: false, error: 'Project ID não encontrado. Abra um projeto no lovable.dev.' });

  const amount = parseFloat(creditAmount) || 0;
  if (amount <= 0 || amount > 5) {
    return res.status(400).json({ success: false, error: 'Custo de créditos inválido' });
  }

  try {
    // PASSO 1: Validar chave + descontar créditos (atômico, via RPC)
    const creditResult = await callRPC('nexus_use_credits', { p_key: api_key, p_amount: amount });

    if (!creditResult || creditResult.success !== true) {
      const errorMsg = (creditResult && creditResult.error) || 'Chave inválida ou revogada';
      const status = errorMsg.includes('insuficientes') ? 402 : 401;
      return res.status(status).json({
        success: false,
        error: errorMsg,
        remaining: (creditResult && creditResult.remaining) || 0
      });
    }

    // PASSO 2: Créditos descontados — encaminhar pro n8n
    if (!N8N_WEBHOOK) {
      return res.status(500).json({ success: false, error: 'N8N webhook não configurado', remaining: creditResult.remaining });
    }

    const n8nBody = { message, token, projectId };
    if (images && images.length > 0) {
      n8nBody.files = images.map((img, i) => ({ data: img, name: `image_${i}.png`, type: 'image/png' }));
    }

    const n8nResponse = await fetch(N8N_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(n8nBody)
    });

    if (!n8nResponse.ok) {
      const errText = await n8nResponse.text();
      return res.status(502).json({
        success: false,
        error: `Erro ao enviar mensagem: ${n8nResponse.status}`,
        remaining: creditResult.remaining
      });
    }

    let n8nData;
    try {
      const n8nText = await n8nResponse.text();
      n8nData = n8nText ? JSON.parse(n8nText) : {};
    } catch {
      n8nData = {};
    }

    return res.json({ success: true, data: n8nData, remaining: creditResult.remaining });

  } catch (e) {
    console.error('[send] Error:', e.message);
    return res.status(502).json({ success: false, error: 'Erro de conexão com o servidor' });
  }
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`[nexus-proxy] Running on port ${PORT}`);
});
