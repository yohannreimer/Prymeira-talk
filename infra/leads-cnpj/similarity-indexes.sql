-- Prymeira Talk supplemental indexes for bounded similar-company buckets.
-- Upstream already owns indexes for situacao_cadastral, uf, municipio and
-- cnae_fiscal_principal; keep only the missing access paths here.
CREATE INDEX IF NOT EXISTS idx_prymeira_similarity_cnae_secondary_active
  ON cnpj.estabelecimentos
  USING GIN (string_to_array(cnae_fiscal_secundaria, ','))
  WHERE situacao_cadastral = '02';

CREATE INDEX IF NOT EXISTS idx_prymeira_similarity_cnae_primary_active
  ON cnpj.estabelecimentos
  (cnae_fiscal_principal, cnpj_basico, cnpj_ordem, cnpj_dv)
  WHERE situacao_cadastral = '02';

CREATE INDEX IF NOT EXISTS idx_prymeira_similarity_cnae_group_active
  ON cnpj.estabelecimentos
  (left(cnae_fiscal_principal, 3), cnpj_basico, cnpj_ordem, cnpj_dv)
  WHERE situacao_cadastral = '02';

CREATE INDEX IF NOT EXISTS idx_prymeira_similarity_uf_active
  ON cnpj.estabelecimentos (uf, cnpj_basico, cnpj_ordem, cnpj_dv)
  WHERE situacao_cadastral = '02';

CREATE INDEX IF NOT EXISTS idx_prymeira_similarity_municipio_active
  ON cnpj.estabelecimentos (municipio, cnpj_basico, cnpj_ordem, cnpj_dv)
  WHERE situacao_cadastral = '02';

CREATE INDEX IF NOT EXISTS idx_prymeira_similarity_porte_cnpj
  ON cnpj.empresas (porte, cnpj_basico);

CREATE INDEX IF NOT EXISTS idx_prymeira_similarity_legal_nature_cnpj
  ON cnpj.empresas (natureza_juridica, cnpj_basico);

ANALYZE cnpj.estabelecimentos;
ANALYZE cnpj.empresas;
