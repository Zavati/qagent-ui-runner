# QAgent UI Runner 0.2.1 — UI-EXEC-2

Runner Node.js + Playwright Chromium para executar planos imutáveis `qagent.ui-test-design.v2` em **lotes**. Um item representa uma observação e produz dois resultados: `UI_REPLAY`, seguido de `UI_LIVE`, em contextos de navegador novos e independentes.

Esta versão inclui hospedagem em **Cloudflare Containers**, com Worker e Durable Object de controle. O mesmo motor também pode executar pela CLI, Docker ou CI. O Gateway conserva a autoridade sobre lotes, claims, cancelamento, resultados e evidências. O botão conjunto da Console aciona os serviços API e UI, mantendo seus resultados separados.

## O que esta versão entrega

- Ativação durável pelo Gateway, inicialização/saúde/encerramento do container e recuperação de despacho. O runtime consulta o estado autoritativo antes de assumir itens.
- Perfil explicitamente sem autenticação para começar a executar na plataforma enquanto login e preparação da aplicação estão pendentes.
- Publicação progressiva de evidências já produzidas; anexos recebidos pelo Gateway continuam consultáveis quando não há resultado final.
- Interpretação determinística de NAVIGATE, CLICK, FILL, SELECT, CHECK e SCROLL. Valores vêm de artefatos observados e verificados; o Runner não pede à IA que invente passos.
- Remapeamento de locators observados, exigindo correspondência única. Checkpoints são alcançados pelas ligações explícitas `stateBeforeId`/`stateAfterId`. Ordem temporal sem ligação não é tratada como prova causal.
- Replay estrito de APIs de negócio: contexto documento/navegação/frame/step, método, origem mapeada, caminho, query com ordem/duplicatas, bytes do corpo, headers de negócio e ocorrência. Cada fixture é consumida no máximo uma vez. Requisição não casada, esgotada ou ambígua é bloqueada; POST de navegação/beacon sem fixture também é bloqueado.
- Live: a aplicação emite as chamadas atuais e recebe suas respostas reais. O Runner não envia uma lista de chamadas históricas à API. Divergências de dados observados são registradas como diferenças pendentes; não são aprovadas automaticamente.
- Comparações de presença, unicidade, tag, atributos, texto direto, tipo/valor/checked de campos, scroll, posições e estilos. Geometria exige viewport/DPR/scroll compatíveis e conserva a pendência sobre o perfil histórico de renderização que não foi observado.
- SHA-256 do plano, manifesto e de cada artefato; escopo e referências imutáveis conferidos. Cache de artefatos em disco, sem carregar a jornada inteira em memória.
- Lotes, worker persistente, execução existente, heartbeat/cancelamento, saída JSON/JUnit, CI e Docker. O Runner não reexecuta Live depois de um ACK perdido.
- Resultados em páginas NDJSON e binários segmentados. O conjunto pode exceder 768 KiB: não há corte silencioso de checks, rede, pendências ou evidências.

### Estado do gate nesta versão

**Executar ações e comparar campos não significa que `ALL_OBSERVED` está completamente validado.** Metadados da fonte, propriedades de documentos/recursos e suas relações, HTML/JS arquivados, comparação de screenshots e campos sem comparador permanecem registrados como pendentes. Checkpoint instável ou sem ligação, iframe, shadow DOM, arquivo, multiselect, popup, download, diálogo e WebSocket também não recebem aprovação implícita.

O contabilizador desta 0.2.1 registra sempre pendências para os metadados da fonte e os documentos de um envelope normal. Portanto, **o gate `ALL_OBSERVED` permanece `INCOMPLETE` quando as verificações executadas não falham**; também pode terminar `FAILED`, `BLOCKED`, `ERROR` ou `CANCELLED`. Não há caminho honesto para um envelope normal ficar completamente `PASSED` nesta cobertura inicial. `INCOMPLETE` sai com código **2**, e não com sucesso de CI. A interface/protocolo de CI estão preparados; os comparadores de cobertura integral ainda precisam ser implementados. Reduzir o contador ou apagar uma seção não é uma alternativa.

As fixtures indisponíveis por cache HTTP 304 continuam como a pendência acordada. Elas bloqueiam Replay; Live é avaliado separadamente. Esta versão não reconstrói corpos de cache nem transforma 304 em resposta inventada.

## Deploy pelo mesmo padrão do Gateway

O workflow `.github/workflows/runner-ci.yml` agora testa e publica o serviço.
A configuração foi comparada com `.github/workflows/deploy.yml` do `qagent-gateway`:

| Configuração | Runner UI |
| --- | --- |
| Publicação automática | Push na `main`, depois dos testes. |
| Publicação manual | GitHub Actions → Run workflow, selecionando `main`. |
| Executor de deploy | `ubuntu-latest`, com Docker verificado por `docker info`. |
| GitHub Environment | `CLOUDFLARE_API_TOKEN`, mesmo nome do Gateway. |
| Secrets de deploy | `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID`. |
| Comando | `npx wrangler deploy`. |
| Node no job de deploy | 24, compatível com o Runner e o Wrangler desta versão. |

O job de testes existente continua na imagem Playwright fixada. Ele executa
verificação sintática, testes Node e aceitação Chromium. O job de publicação
depende de seu sucesso e roda no host Ubuntu, com acesso ao Docker. Pull requests
e outras branches executam testes sem publicar. Deploys deste workflow são
serializados; um novo push não interrompe uma publicação em andamento.

No repositório `qagent-ui-runner`, disponibilize os mesmos nomes de secrets no
Environment `CLOUDFLARE_API_TOKEN` ou conceda acesso aos secrets de organização.
Um secret definido apenas no repositório do Gateway não é copiado para outro
repositório pelo workflow. O valor do token deve autorizar Worker e Containers
na conta selecionada. Nenhuma credencial foi incluída no código.

O build da imagem acontece no GitHub neste fluxo. Você pode copiar os arquivos,
conferir o diff e fazer seu commit/push sem executar Docker no computador local.
O container continua necessário para o processo Node/Chromium; o arquivo Wrangler
mantém a imagem, o Durable Object, a migration e a entrada interna do serviço.

Os secrets de runtime `UI_RUNNER_DISPATCH_SECRET` e `UI_RUNNER_SCOPES_JSON`
continuam configurados no Worker. Eles permitem receber o despacho e consumir
os lotes do QAgent; são distintos das credenciais que autorizam o deploy.
O workflow não os recria nem substitui em cada publicação.

Se preferir deploy manual local, use a seção seguinte com Docker ativo.

## Instalação e deploy local

Node.js 22 ou superior; Node 24 permite usar também as suítes SQLite dos demais projetos. Para hospedar, é preciso Docker Desktop/daemon ativo e uma conta Cloudflare com Workers Paid/Containers. Na pasta do Runner:

```bash
npm ci
npm run check
docker info
npx wrangler login
npx wrangler deploy
```

O deploy publica o Worker e a imagem definida em `Dockerfile.cloudflare`. Publique o Runner antes do Gateway que o referencia. O projeto contém seu próprio `wrangler.jsonc`, sem rota pública ou `workers.dev`. O Gateway o aciona por service binding `UI_RUNNER` e HMAC; o token de execução do escopo permite ao processo consumir os itens.

Playwright e sua imagem estão fixados em **1.62.1**; Wrangler está fixado em **4.168.0**. `build` executa a verificação dos módulos, e `deploy` usa Wrangler. Não é necessário instalar Chromium localmente para construir a imagem hospedada.

Siga o [guia completo de implantação](../README-IMPLANTACAO.md) para os comandos com os IDs do ambiente, os secrets, a migration e o deploy do Gateway/Console. O [guia Cloudflare](docs/CLOUDFLARE.md) detalha saúde, alarmes, capacidade e encerramento. A configuração não foi publicada remotamente nesta preparação.

### Helper de configuração

`scripts/configure-cloudflare.mjs` gera `private-cloudflare/runner-secrets.json` e `private-cloudflare/gateway-secrets.json`. O primeiro recebe `UI_RUNNER_DISPATCH_SECRET` e `UI_RUNNER_SCOPES_JSON`; o segundo recebe o mesmo segredo de despacho, perfis e hashes dos tokens de máquina. O helper não imprime tokens nem faz deploy.

Se já houver configuração, forneça os arquivos locais atuais com `--gateway-secrets` e `--runner-secrets`. O helper preserva seus arrays e perfis existentes. Ele não lê valores de secrets remotos; aplicar `secret bulk` substitui a chave inteira, incluindo o array. O guia principal apresenta comandos separados para configuração existente e primeira implantação.

Use um novo perfil como `profile_stg_cloudflare` para o modo sem login. Um perfil antigo com `REQUIRE_ADAPTER` é preservado. `--allowed-origins` acrescenta origens HTTPS de APIs externas, quando necessárias. A URL alvo precisa ser uma origem HTTPS, sem caminho/query/credenciais. Se ocorrer uma gravação interrompida, `node scripts/configure-cloudflare.mjs --recover` recupera os mesmos arquivos e credenciais.

### Execução local ou em executor próprio

```bash
npm ci
npm run browser:install
```

A CLI usa as mesmas regras de atribuição e o mesmo motor da hospedagem.

## Configuração de ambiente

O Gateway precisa dos perfis `UI_EXECUTION_PROFILES_JSON` e dos tokens de máquina `UI_EXECUTION_TOKENS_JSON`. O perfil congela alvo, origens, mapa de origens, viewport, localidade, timezone, timeouts e modo de preparação para o lote. O token tem escopo de organização/projeto/ambiente; `read` e `execute` permitem consumir itens, e `create` permite admitir lotes pelo CI.

O helper do guia principal cria **`profile_stg_cloudflare`**, com `preparationMode: UNAUTHENTICATED`. Os exemplos de adaptador local continuam usando **`profile_stg_chromium`** e `preparationKey: prepare_stg`. O ID seleciona o perfil do Gateway; a chave seleciona o módulo local. São configurações distintas.

Nesta máquina:

```bash
export QAGENT_API_URL=https://api.apiqagent.com
export QAGENT_PROJECT_ID=prj_seu_projeto
export QAGENT_ENVIRONMENT_ID=env_stg
export QAGENT_TOKEN='token-de-maquina-configurado-no-gateway'
export QAGENT_RUNNER_CONFIG=./private-runner/runner.config.json
```

`QAGENT_RUNNER_CONFIG` é usado para perfis com adaptador; o modo `UNAUTHENTICATED` não exige esse arquivo. Na hospedagem, o Worker recebe o token por `UI_RUNNER_SCOPES_JSON` e fornece somente a configuração do escopo do lote ao container.

O token deve ter 32–512 caracteres de `[A-Za-z0-9._~-]` e as permissões necessárias ao escopo. O Runner recebe esse token; segredos HMAC internos de `qagent-ui`/Registry não entram no processo de navegador.

O browser precisa alcançar as origens do perfil. Cada origem de API diferente da origem da tela precisa de um mapeamento explícito ou constar nas origens permitidas. O mapa preserva caminhos e pares de query; não há reescrita implícita de prefixo de caminho. Alvos com credenciais embutidas, mapeamento reverso ambíguo ou redirect fora das origens permitidas são rejeitados.

## Preparação de autenticação e dados

### Iniciar sem login nesta etapa

`preparationMode: UNAUTHENTICATED` permite abrir o navegador e tentar o roteiro sem adaptador de login. O Runner conserva as pendências `UI_RUNNER_AUTHENTICATION_NOT_CONFIGURED`, `UI_RUNNER_TARGET_BUILD_UNVERIFIED`, `UI_RUNNER_BASELINE_STATE_UNPREPARED` e `UI_RUNNER_LIVE_STATE_NOT_PREPARED`. Não declara que o build foi conferido ou que o estado da aplicação foi restaurado.

Uma resposta 401 inesperada pode produzir `UI_RUNNER_AUTHENTICATION_REQUIRED`; 403 pode produzir `UI_RUNNER_ACCESS_FORBIDDEN`, como falhas de acesso da aplicação. Um cenário negativo cuja resposta observada esperada seja 401 não vira automaticamente falha de autenticação. O resultado registra o que foi efetivamente comparado.

Autenticação de máquina Runner → Gateway continua obrigatória. As credenciais usadas pelo fluxo de testes API não são transformadas em cookies/login UI. A imagem padrão desta entrega permite o perfil sem autenticação e não inclui um adaptador específico da sua aplicação.

### Usar um adaptador confiável

O padrão de perfis anteriores continua `REQUIRE_ADAPTER`. Na hospedagem, um escopo pode informar `configPath`, com módulos presentes em uma imagem derivada; veja [CLOUDFLARE.md](docs/CLOUDFLARE.md). Para execução local:

Copie os arquivos de `examples/` para uma pasta local `private-runner/` e adapte `prepare.mjs` à aplicação. O exemplo requer endpoints reais de build e preparação; ele não declara prontidão sem verificá-los.

```json
{
  "preparations": {
    "prepare_stg": {
      "module": "./prepare.mjs",
      "allowedOrigins": ["https://stg.example.test"],
      "storageStateFile": "./storage-state.json",
      "liveAllowed": true
    }
  }
}
```

`storageStateFile` é opcional e usa o formato Playwright. O módulo deve estar dentro da pasta do arquivo de configuração e exportar:

```js
export async function prepare({ context, page, mode, profile, targetBuildRef, signal }) {
  // Verificar o build realmente implantado, autenticar e restaurar/semear o estado esperado.
  // Executado independentemente em UI_REPLAY e UI_LIVE.
  return {
    ready: true,
    baselineReady: true,
    verifiedTargetBuildRef: targetBuildRef,
    liveStatePrepared: mode === 'UI_LIVE'
  };
}
```

O retorno é a confirmação do adaptador local confiável após as verificações; simplesmente copiar esse retorno não verifica build nem prepara dados. Para Live, prepare um tenant/dataset isolado por execução e restaure o estado antes do modo. O Runner não consegue desfazer genericamente uma operação de negócio feita pela aplicação.

A preparação tem uma fronteira explícita. Sua página recebe proteção de origens, é fechada ao terminar e suas chamadas não consomem fixtures nem entram nos contadores do teste. Cookies/storage ficam no contexto; o teste começa em uma página nova. O módulo local pode usar `context.request` para seed/reset autenticado: valide também os destinos dessas chamadas no próprio adaptador. Nenhum JavaScript recebido de uma API é avaliado. HTML/JS capturados continuam evidência, sem execução de arquivo arquivado.

## Uso em lotes

Com a hospedagem configurada, toda admissão UI do escopo já desperta o container. A Console ou POST cria o lote; GETs de batch/relatório acompanham a execução. Os comandos `worker`/`--run` abaixo são alternativas de execução local/CI e fornecem compute adicional; não são necessários para a execução Cloudflare.

Criar o lote e executar todas as versões v2 elegíveis:

```bash
node src/cli.js create --all --profile profile_stg_chromium --target-build build_2026_11_23 --operation-id ui_pipeline_1042 --run
```

`--all` exige inventário completo e seleciona somente itens `executable:true`. Itens antigos/revogados são diagnosticados. A requisição de admissão é salva em `qagent-results/admissions/` antes do POST; repetir o mesmo `operationId` usa as mesmas versões congeladas. Para CI, use um identificador estável da operação de pipeline. Uma nova execução deliberada deve usar outro identificador.

Selecionar um lote de versões explicitamente:

```bash
node src/cli.js create --profile profile_stg_chromium --target-build build_2026_11_23 --design-version uitdv_primeiro --design-version uitdv_segundo --run
```

Executar lote já criado na aba Automação:

```bash
node src/cli.js run --batch uieb_id_do_lote
```

Worker contínuo que procura itens nos lotes do escopo autorizado:

```bash
node src/cli.js worker
```

`worker --once` processa no máximo um item. Vários workers podem consumir lotes: a atribuição e a exclusão ficam no lease do Gateway. Cada processo executa um item de cada vez. O executor hospedado também pode consumir o lote; a CLI acompanha o resultado canônico sem assumir itens já atribuídos.

Na CLI, SIGINT/SIGTERM interrompe o browser e tenta registrar cancelamento, sem continuar para o modo seguinte. Na hospedagem, encerramento do host usa `UI_RUNNER_HOST_SHUTDOWN`, distinguindo interrupção técnica de cancelamento solicitado pelo usuário.

`create` sem `--run` confirma apenas a admissão, sem declarar teste aprovado. `report --batch ID` baixa o JSON/JUnit do Gateway. Os comandos `run` e `create --run` usam os códigos de saída da execução.

| Saída | Significado |
| --- | --- |
| 0 | Gate aprovado, Replay e Live completos e sem pendências |
| 1 | Falha em verificação |
| 2 | Bloqueado, incompleto ou problema técnico |
| 130 | Cancelado |

## Evidências, retries e recuperação

O Runner publica páginas e anexos à medida que ficam prontos. `REPORT_PAGE` usa **`application/x-ndjson`**; `MODE_RESULT` usa **`application/json`** e conserva o resultado de um modo mesmo antes da conclusão do par. Hash, tamanho, modo e tipo permanecem associados ao item. O Gateway pode devolver `items[].evidence` com `partialEvidence: true` mesmo quando `result` é `null`; a Console oferece os downloads dessas evidências já recebidas.

**Somente uploads confirmados são duráveis.** O disco do container é temporário. Uma queda pode perder dados ainda não publicados; os anexos existentes não fazem essa tentativa parecer concluída ou aprovada. Escritas feitas com claim expirado continuam sendo rejeitadas.

Cada item fica em `qagent-results/<batchId>/<itemId>/`: `result.json`, `junit.xml`, páginas de checks/pending/network, screenshot final e trace Playwright. Strings grandes aparecem no relatório por hash/tamanho e referência à fonte; a comparação usa os valores completos. Corpos atuais diferentes de até 8 MiB são guardados como evidência; corpos maiores preservam hash/tamanho e uma pendência explícita.

`ModeResult.externalized:true` exige arrays inline vazios e `reportPages`. A soma dos `count` de cada coleção reproduz todos os registros. `checksPassed/Failed/Pending` correspondem aos status das linhas de checks; `requestsObserved` é o número de linhas da rede. O Gateway reconcilia as páginas recebidas antes da finalização.

Traces/binários maiores que 8 MiB são divididos. O manifesto `qagent.ui-execution-binary-parts.v1` informa partes em ordem, tamanho e SHA-256 total; concatene as partes e valide o hash antes de abrir o trace. Repetições de um mesmo anexo não criam referências duplicadas.

O resultado e as páginas são salvos **antes** do upload. Uma falha no envio mantém a cópia local enquanto o disco daquele processo existir; isso não garante sua retenção depois que um container for removido. Retries de upload/result repetem apenas transporte idempotente. Um claim cujo ACK foi perdido não é reivindicado automaticamente de novo. Lease expirada é erro técnico; uma execução de Live não é repetida automaticamente.

Timeouts: o perfil controla passo (normalmente 7 s) e modo; o cliente usa 30 s para operações pequenas e 60 s para source/artifacts. O heartbeat continua a cada 20 s, inclusive durante leitura/envio. Esses limites operacionais encerram explicitamente trabalho que não terminou; não cortam a jornada em 512 artefatos nem omitem checks.

## Docker e integração contínua

A superfície de máquina UI continua `/v1/automation/projects/:projectId/environments/:environmentId/ui-executions`. A admissão conjunta API + UI desta entrega pertence à sessão da Console. O token UI não recebe autoridade para executar API automaticamente.

Para um executor próprio, o `Dockerfile` mantém a CLI. O `Dockerfile.cloudflare` é a entrada hospedada publicada por Wrangler.

```bash
docker build -t qagent-ui-runner:0.2.1 .
docker run --rm --init --ipc=host \
  --env-file ./private-runner/runner.env \
  -v "$PWD/private-runner:/config:ro" \
  -v "$PWD/qagent-results:/app/qagent-results" \
  qagent-ui-runner:0.2.1 \
  run --batch uieb_id_do_lote --config /config/runner.config.json
```

A pasta de saída montada precisa permitir escrita pelo usuário `pwuser` do contêiner. O exemplo de GitHub Actions está em `examples/ui-execution-ci.yml`. O workflow de verificação do próprio Runner executa os testes de contrato/transporte e a aceitação Chromium no contêiner fixado.

## Verificação desta entrega

```bash
npm run check
npm test
npm run test:hosted
npm run test:browser
```

Os testes unitários cobrem integridade, escopo, query/headers/body/contexto, consumo em rajadas, JSON inválido/duplicado, locators, paginação além de 768 KiB, deduplicação, binários segmentados, transporte idempotente, cleanup de heartbeat/browser, seis ações e gates CI. O teste `browser.acceptance.js` serve uma aplicação sintética e exige que Replay use o body observado sem chamar o backend, que Live faça uma chamada real e que o contexto seja novo. Ele não é pulado nem convertido em sucesso quando Chromium não abre.

Na preparação do pacote, as verificações Node e os testes de hospedagem passaram. As integrações usam módulos reais e SQLite, com Chromium, rede externa e Container simulados quando necessários. O bundle do Worker foi verificado com `wrangler deploy --dry-run --containers-rollout=none`.

Docker não estava disponível para construir/publicar a imagem. A aceitação com Chromium real não pôde concluir porque o sistema bloqueou `socket()` ao abrir `/usr/bin/chromium` (`EPERM`); ela não foi convertida em sucesso. Nenhum deploy remoto foi feito. O aceite hospedado exige iniciar o lote na Console, observar o navegador, consultar Replay/Live, baixar evidências publicadas e confirmar o encerramento do container no seu ambiente.

Referências da implementação: [rotas e fulfill](https://playwright.dev/docs/api/class-route), [interceptação de rede](https://playwright.dev/docs/network), [Docker e compatibilidade de versão](https://playwright.dev/docs/docker).
