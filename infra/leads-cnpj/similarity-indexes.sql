-- Prymeira Talk supplemental indexes for bounded similar-company buckets.
-- Upstream already owns indexes for situacao_cadastral, uf, municipio and
-- cnae_fiscal_principal; keep only the missing access paths here.
CREATE INDEX IF NOT EXISTS idx_estabelecimentos_cnae_secondary_array_gin
  ON cnpj.estabelecimentos
  USING GIN (string_to_array(cnae_fiscal_secundaria, ','));

CREATE INDEX IF NOT EXISTS idx_estabelecimentos_cnae_primary_group
  ON cnpj.estabelecimentos (left(cnae_fiscal_principal, 3));

CREATE INDEX IF NOT EXISTS idx_empresas_porte_cnpj
  ON cnpj.empresas (porte, cnpj_basico);

CREATE INDEX IF NOT EXISTS idx_empresas_legal_nature_cnpj
  ON cnpj.empresas (natureza_juridica, cnpj_basico);

ANALYZE cnpj.estabelecimentos;
ANALYZE cnpj.empresas;
