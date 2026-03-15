-- =============================================
-- MIGRAÇÃO: Adicionar sistema de logs
-- Execute no Supabase SQL Editor
-- NÃO apaga dados existentes
-- =============================================

-- 1. Criar tabela de logs
CREATE TABLE IF NOT EXISTS admin_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE admin_logs ENABLE ROW LEVEL SECURITY;

-- 2. Função para criar log
CREATE OR REPLACE FUNCTION admin_create_log(p_user TEXT, p_action TEXT, p_details TEXT DEFAULT '')
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO admin_logs (admin_user, action, details)
  VALUES (p_user, p_action, COALESCE(p_details, ''));
  RETURN json_build_object('success', true);
END;
$$;

-- 3. Função para listar logs
CREATE OR REPLACE FUNCTION admin_list_logs(p_limit INTEGER DEFAULT 100)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN (
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)
    FROM (
      SELECT id, admin_user, action, details, created_at
      FROM admin_logs
      ORDER BY created_at DESC
      LIMIT p_limit
    ) t
  );
END;
$$;
