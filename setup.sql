-- ============================================
-- NEXUS PAINEL - DATABASE SETUP (DO ZERO)
-- Execute TUDO no Supabase SQL Editor
-- ============================================

-- 1. Limpar RPCs antigas (se existirem)
DROP FUNCTION IF EXISTS nexus_validate_key(text);
DROP FUNCTION IF EXISTS nexus_use_credits(text, numeric);
DROP FUNCTION IF EXISTS nexus_use_credits(text, integer);
DROP FUNCTION IF EXISTS admin_list_keys();
DROP FUNCTION IF EXISTS admin_create_key(text, integer, text);
DROP FUNCTION IF EXISTS admin_update_key_status(uuid, text);
DROP FUNCTION IF EXISTS admin_add_credits(uuid, integer);
DROP FUNCTION IF EXISTS admin_delete_key(uuid);

-- 2. Recriar tabela do zero
DROP TABLE IF EXISTS api_keys CASCADE;

CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_value TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  name TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  credits NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (credits >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

-- 3. RLS — bloquear acesso direto (tudo via RPCs SECURITY DEFINER)
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
-- Nenhuma policy = zero acesso direto com anon key

-- =============================================
-- 4. RPCs PARA A EXTENSÃO
-- =============================================

-- Validar key (sem gastar créditos)
CREATE OR REPLACE FUNCTION nexus_validate_key(p_key TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rec RECORD;
BEGIN
  SELECT id, status, credits INTO rec
  FROM api_keys
  WHERE key_value = p_key
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('valid', false, 'error', 'Chave inválida');
  END IF;

  IF rec.status != 'active' THEN
    RETURN json_build_object('valid', false, 'error', 'Chave revogada');
  END IF;

  RETURN json_build_object('valid', true, 'credits', rec.credits);
END;
$$;

-- Usar créditos (validar + descontar atomicamente)
CREATE OR REPLACE FUNCTION nexus_use_credits(p_key TEXT, p_amount NUMERIC)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rec RECORD;
  new_credits NUMERIC(10,2);
BEGIN
  SELECT id, status, credits INTO rec
  FROM api_keys
  WHERE key_value = p_key
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Chave inválida');
  END IF;

  IF rec.status != 'active' THEN
    RETURN json_build_object('success', false, 'error', 'Chave revogada');
  END IF;

  IF rec.credits < p_amount THEN
    RETURN json_build_object('success', false, 'error', 'Créditos insuficientes', 'remaining', rec.credits);
  END IF;

  new_credits := rec.credits - p_amount;

  UPDATE api_keys
  SET credits = new_credits, last_used_at = now()
  WHERE id = rec.id;

  RETURN json_build_object('success', true, 'remaining', new_credits);
END;
$$;

-- =============================================
-- 5. RPCs PARA O ADMIN PANEL
-- =============================================

-- Listar todas as keys
CREATE OR REPLACE FUNCTION admin_list_keys()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)
    FROM (
      SELECT id, key_value, key_hint, name, status, credits, created_at, last_used_at
      FROM api_keys
      ORDER BY created_at DESC
    ) t
  );
END;
$$;

-- Criar nova key
CREATE OR REPLACE FUNCTION admin_create_key(p_key_value TEXT, p_credits INTEGER DEFAULT 100, p_name TEXT DEFAULT '')
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_id UUID;
BEGIN
  INSERT INTO api_keys (key_value, key_hint, credits, name)
  VALUES (p_key_value, RIGHT(p_key_value, 4), p_credits, COALESCE(p_name, ''))
  RETURNING id INTO new_id;

  RETURN json_build_object('success', true, 'id', new_id);
END;
$$;

-- Atualizar status (revogar/ativar)
CREATE OR REPLACE FUNCTION admin_update_key_status(p_id UUID, p_status TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE api_keys SET status = p_status WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Key não encontrada');
  END IF;
  RETURN json_build_object('success', true);
END;
$$;

-- Adicionar créditos
CREATE OR REPLACE FUNCTION admin_add_credits(p_id UUID, p_amount NUMERIC)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  new_credits NUMERIC(10,2);
BEGIN
  UPDATE api_keys SET credits = credits + p_amount WHERE id = p_id
  RETURNING credits INTO new_credits;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Key não encontrada');
  END IF;

  RETURN json_build_object('success', true, 'credits', new_credits);
END;
$$;

-- Deletar key
CREATE OR REPLACE FUNCTION admin_delete_key(p_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM api_keys WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Key não encontrada');
  END IF;
  RETURN json_build_object('success', true);
END;
$$;

-- =============================================
-- MIGRAÇÃO (banco já existente — não recriar do zero)
-- Se a tabela api_keys já existe, execute SOMENTE este comando:
-- ALTER TABLE api_keys ALTER COLUMN credits TYPE NUMERIC(10,2) USING credits::NUMERIC(10,2);
-- =============================================
