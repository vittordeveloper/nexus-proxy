// Supabase Edge Function: validate-key
// Valida se uma API key existe e está ativa SEM consumir créditos
// Deploy: supabase functions deploy validate-key

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { api_key } = await req.json()

    if (!api_key) {
      return new Response(
        JSON.stringify({ error: 'api_key é obrigatório' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Usar service_role para bypass RLS
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Buscar key pelo hash ou valor completo — depende de como use-credits faz
    // Opção 1: Se a tabela tem coluna api_key com valor completo
    const { data, error } = await supabase
      .from('api_keys')
      .select('id, credits, status, key_hint')
      .eq('api_key', api_key)
      .eq('status', 'active')
      .maybeSingle()

    if (error) {
      // Se api_key não é coluna, tenta key_hint
      const hint = api_key.slice(-4)
      const { data: data2, error: error2 } = await supabase
        .from('api_keys')
        .select('id, credits, status, key_hint')
        .like('key_hint', `%${hint}`)
        .eq('status', 'active')
        .maybeSingle()

      if (error2 || !data2) {
        return new Response(
          JSON.stringify({ error: 'Chave inválida ou revogada' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      return new Response(
        JSON.stringify({ success: true, remaining: data2.credits }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!data) {
      return new Response(
        JSON.stringify({ error: 'Chave inválida ou revogada' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({ success: true, remaining: data.credits }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Erro interno: ' + err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
