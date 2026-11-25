# Perfis UI derivados dos ambientes existentes do QAgent

O Runner Cloudflare NAO recebe `UI_EXECUTION_PROFILES_JSON`. Ao admitir um lote, o Gateway carrega a configuracao de projeto/ambiente ja existente (`environments.web_base_url` e bindings de API) e congela o perfil no snapshot do lote. O Runner recebe o snapshot pela API do Gateway, com versao fixa dos designs e hashes dos artefatos.

## Configuracoes de origem

- Console > Projeto > Ambiente: Web Base URL (`webBaseUrl`) define o site que o Chromium abre.
- API Services vinculados ao ambiente: as bases de API sao incorporadas ao allowlist de origens da execucao.
- Auth profiles no Gateway/Vault: continuam existentes, mas **nao** sao convertidos automaticamente em login de navegador. O perfil UI inicia `UNAUTHENTICATED` e problemas de acesso devem produzir resultados incompletos/falhas explicitas. Uma futura integracao browser-auth JIT deve utilizar as referencias existentes, sem enviar credenciais no endpoint de listagem.
- Chromium, viewport 1280x720, pt-BR, America/Sao_Paulo, timeout 7s/600s sao defaults do adaptador; nao existem como campos persistidos na configuracao atual do ambiente.

## Nao confundir

`UI_RUNNER_SCOPES_JSON` (Cloudflare runner) e `UI_EXECUTION_TOKENS_JSON` (Gateway) ainda sao necessarios na UI-EXEC-2 para autorizacao de maquina/escopo. Esta mudanca elimina a dependencia dos perfis JSON de execucao, **nao** migra essas duas listas de credenciais. `UI_RUNNER_DISPATCH_SECRET` segue igual nos dois servicos. Remover/alterar essas chaves sem implementar outro protocolo de autenticacao interrompe a execucao.

## Implantacao

1. Garanta que o ambiente do projeto tem **Web Base URL** preenchido; se faltar, GET /ui-executions/profiles retornara items [].
2. Implante o Gateway deste pacote com `UI_EXECUTION_PROFILE_SOURCE: "PROJECT"` no bloco `vars` do `wrangler.jsonc`. Verifique que `/ui-executions/profiles` retorna um perfil `profile_ui_<environmentId>`.
3. Ajuste a selecao do perfil no Console usando o ID que o Gateway retornou, e execute um lote novo. Lotes antigos mantem o snapshot anterior.
4. Quando a nova consulta funcionar, remova o secret antigo: `npx wrangler secret delete UI_EXECUTION_PROFILES_JSON` **somente do Gateway**.
5. **Nao** altere os segredos de autenticação de servicos, binding UI_RUNNER ou o container para essa mudanca.

O `UI_EXECUTION_PROFILES_JSON` antigo e suportado temporariamente no Gateway para rollout sem quebra. Defina `UI_EXECUTION_PROFILE_SOURCE=PROJECT` em `vars` para usar o banco mesmo enquanto o secret antigo existir; remova o secret somente depois de validar o novo caminho. Se a variavel nao for configurada e o secret antigo existir, o modo legado prevalece.
