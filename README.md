# Nexus Auth Proxy

Proxy de autenticação para o Nexus Painel. Roda no Railway.

## Deploy no Railway

1. Acesse [railway.app](https://railway.app/) e faça login com GitHub
2. Clique em **New Project** → **Deploy from GitHub repo**  
   (ou **Empty Project** → **Add Service** → **GitHub Repo**)
3. Selecione este repositório
4. Nas **Settings** do serviço:
   - **Variables**: Adicione:
     - `SB_URL` = `https://esfnjnxhbfenziudrhqj.supabase.co`
     - `SB_KEY` = `(sua anon key do Supabase)`
   - **Networking** → **Generate Domain** (vai gerar algo como `nexus-auth-proxy-production-xxxx.up.railway.app`)
5. Clique em **Deploy**
6. Copie a URL gerada (ex: `https://nexus-auth-proxy-production-xxxx.up.railway.app`)

## Atualizar a extensão

Depois de deploiar, atualize a `AUTH_PROXY_URL` no `background.js` da extensão com a nova URL:
- URL base do Railway + `/webhook/nexus-auth-proxy`
- Exemplo: `https://nexus-auth-proxy-production-xxxx.up.railway.app/webhook/nexus-auth-proxy`

## Endpoints

### POST /webhook/nexus-auth-proxy

**validate_license** - Valida se uma key é válida SEM consumir créditos (usa cache de 10 min):
```json
{ "action": "validate_license", "api_key": "sk_live_..." }
```
Resposta sucesso: `{ "statusCode": 200, "data": { "success": true, "remaining": 95 }, "ok": true }`  
Resposta erro: `{ "statusCode": 401, "data": { "error": "Chave inválida ou revogada" }, "ok": false }`

**use_credits** - Consome créditos (chamado em cada prompt):
```json
{ "action": "use_credits", "api_key": "sk_live_...", "amount": 0.9 }
```
