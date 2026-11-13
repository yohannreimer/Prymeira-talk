# Recuperação pontual de histórico WAHA

`node dist/recover-waha-history.js WORKSPACE CHANNEL CONNECTION FROM_ISO TO_ISO [--apply]`

Sem `--apply`, verifica a propriedade da sessão, elegibilidade, geração e primeira página, sem gravar no banco ou criar cursor. Use datas fixas, segundos inteiros, intervalo de até quinze dias e término pelo menos trinta segundos no passado. A conexão precisa estar autenticada e saudável; não existe comando de start, stop, logout ou envio neste operador.

Com `--apply`, cada execução processa no máximo vinte páginas de cinquenta registros, com orçamento de quarenta segundos entre páginas. Repita **os mesmos argumentos** para continuar o cursor em `TALK_MEDIA_STORE_PATH/talk-history-ops`. O arquivo contém escopo, geração, datas, contagens e digests, sem transcrições nem credenciais. Um lock exclusivo impede dois operadores do mesmo intervalo. Caso o processo seja interrompido, investigue seu estado antes de tratar o lock; não remova locks de outro processo.

O modo de persistência é `history`: não incrementa não lidas, não dispara atendimento/follow-up, nem cria envio. A transação canônica conserva mensagens já existentes, revisões e identidades completas. Anexos geram obrigações duráveis de mídia para o worker existente. O checkpoint de recuperação antigo não é saltado nem substituído.

`complete=true` exige duas leituras completas e idênticas da janela do provedor. Só `complete=true` **e** `heldInPass=0` permitem declarar a janela sem pendências de conciliação. Isso comprova cobertura do que o provedor disponibilizou, não de mensagens ausentes no próprio WhatsApp/WAHA. Uma página com conflito fica registrada; não declare histórico integral se houver pendência.

Uma página de verificação idêntica pode reutilizar a prova de persistência da passagem anterior apenas quando ela não tinha nenhum hold. Páginas retidas ou cursores antigos sem essa prova são persistidos novamente.

Para conflitos antigos causados exclusivamente por `pushName` ou arredondamento numérico de latitude/longitude de até uma unidade relativa de precisão (`Number.EPSILON`), publique primeiro a correção do worker. A comparação tolerante não altera coordenadas armazenadas nem aceita deslocamentos reais. A retomada normal da página antiga usa a origem física atual e mantém conteúdo e provas de endereço. É permitido antecipar somente `historyRecoveryNextAttemptAt` da conexão alvo, com guarda de geração e lease, sem alterar `recoveredThroughAt` ou apagar o cursor. Confirme avanço e ausência do erro antes do backfill recente.

Na implantação, atualize somente o worker de histórico/ingresso. Preserve os serviços WAHA, API e frontend, os volumes, segredos e configurações existentes. Registre imagem anterior e nova por digest, confirme tráfego real e mantenha rollback disponível. Não envie mensagens de teste a clientes.
