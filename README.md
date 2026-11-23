# QAgent UI Runner 0.1.0 — UI-EXEC-1

Runner Node.js + Playwright Chromium para executar planos imutáveis `qagent.ui-test-design.v2` em **lotes**. Um item representa uma observação e produz dois resultados: `UI_REPLAY`, seguido de `UI_LIVE`, em contextos de navegador novos e independentes. A execução acontece nesta máquina/contêiner; o Gateway conserva o lote, leases, resultados e evidências.

## O que esta versão entrega

- Interpretação determinística de NAVIGATE, CLICK, FILL, SELECT, CHECK e SCROLL. Valores vêm de artefatos observados e verificados; o Runner não pede à IA que invente passos.
- Remapeamento de locators observados, exigindo correspondência única. Checkpoints são alcançados pelas ligações explícitas `stateBeforeId`/`stateAfterId`. Ordem temporal sem ligação não é tratada como prova causal.
- Replay estrito de APIs de negócio: contexto documento/navegação/frame/step, método, origem mapeada, caminho, query com ordem/duplicatas, bytes do corpo, headers de negócio e ocorrência. Cada fixture é consumida no máximo uma vez. Requisição não casada, esgotada ou ambígua é bloqueada; POST de navegação/beacon sem fixture também é bloqueado.
- Live: a aplicação emite as chamadas atuais e recebe suas respostas reais. O Runner não envia uma lista de chamadas históricas à API. Divergências de dados observados são registradas como diferenças pendentes; não são aprovadas automaticamente.
- Comparações de presença, unicidade, tag, atributos, texto direto, tipo/valor/checked de campos, scroll, posições e estilos. Geometria exige viewport/DPR/scroll compatíveis e conserva a pendência sobre o perfil histórico de renderização que não foi observado.
- SHA-256 do plano, manifesto e de cada artefato; escopo e referências imutáveis conferidos. Cache de artefatos em disco, sem carregar a jornada inteira em memória.
- Lotes, worker persistente, execução existente, heartbeat/cancelamento, saída JSON/JUnit, CI e Docker. O Runner não reexecuta Live depois de um ACK perdido.
- Resultados em páginas NDJSON e binários segmentados. O conjunto pode exceder 768 KiB: não há corte silencioso de checks, rede, pendências ou evidências.

### Estado do gate nesta primeira entrega

**Executar ações e comparar campos não significa que `ALL_OBSERVED` está completamente validado.** Metadados da fonte, propriedades de documentos/recursos e suas relações, HTML/JS arquivados, comparação de screenshots e campos sem comparador permanecem registrados como pendentes. Checkpoint instável ou sem ligação, iframe, shadow DOM, arquivo, multiselect, popup, download, diálogo e WebSocket também não recebem aprovação implícita.

O contabilizador desta 0.1.0 registra sempre pendências para os metadados da fonte e os documentos de um envelope normal. Portanto, **o gate `ALL_OBSERVED` permanece `INCOMPLETE` quando as verificações executadas não falham**; também pode terminar `FAILED`, `BLOCKED`, `ERROR` ou `CANCELLED`. Não há caminho honesto para um envelope normal ficar completamente `PASSED` nesta cobertura inicial. `INCOMPLETE` sai com código **2**, e não com sucesso de CI. A interface/protocolo de CI estão preparados; os comparadores de cobertura integral ainda precisam ser implementados. Reduzir o contador ou apagar uma seção não é uma alternativa.

As fixtures indisponíveis por cache HTTP 304 continuam como a pendência acordada. Elas bloqueiam Replay; Live é avaliado separadamente. Esta versão não reconstrói corpos de cache nem transforma 304 em resposta inventada.

## Instalação

Node.js 22 ou superior:

```bash
npm ci
npm run build
npm run browser:install
```

`build` verifica a sintaxe dos módulos ESM; não há compilação TypeScript nem serviço Worker Cloudflare neste projeto. Playwright está fixado em **1.62.1**, com `package-lock.json`. O Docker usa a mesma versão de imagem e não usa `latest`.

## Configuração de ambiente

O Gateway precisa dos perfis `UI_EXECUTION_PROFILES_JSON` e dos tokens de máquina `UI_EXECUTION_TOKENS_JSON`, conforme o projeto Gateway. O perfil congela alvo, origens, mapa de origens, viewport, localidade, timezone, timeouts e `preparationKey` para aquele lote.

Nos exemplos desta entrega, `profileId` é **`profile_stg_chromium`** e seu `preparationKey` é **`prepare_stg`**. O primeiro vai em `--profile`; o segundo é a chave de `preparations` no arquivo local. Eles representam coisas diferentes e precisam corresponder à configuração do Gateway.

Nesta máquina:

```bash
export QAGENT_API_URL=https://api.apiqagent.com
export QAGENT_PROJECT_ID=prj_seu_projeto
export QAGENT_ENVIRONMENT_ID=env_stg
export QAGENT_TOKEN='token-de-maquina-configurado-no-gateway'
export QAGENT_RUNNER_CONFIG=./private-runner/runner.config.json
```

O token deve ter 32–512 caracteres de `[A-Za-z0-9._~-]` e as permissões necessárias ao escopo. O Runner recebe esse token; segredos HMAC internos de `qagent-ui`/Registry não entram no processo de navegador.

O browser precisa alcançar as origens do perfil. Cada origem de API diferente da origem da tela precisa de um mapeamento explícito ou constar nas origens permitidas. O mapa preserva caminhos e pares de query; não há reescrita implícita de prefixo de caminho. Alvos com credenciais embutidas, mapeamento reverso ambíguo ou redirect fora das origens permitidas são rejeitados.

## Preparação local de autenticação e dados

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

`worker --once` processa no máximo um item. Vários workers podem consumir lotes: a atribuição e a exclusão ficam no lease do Gateway. Nesta versão cada processo executa um item de cada vez. O sinal SIGINT/SIGTERM interrompe o browser e tenta concluir o registro de cancelamento; não executa o modo seguinte.

`create` sem `--run` confirma apenas a admissão, sem declarar teste aprovado. `report --batch ID` baixa o JSON/JUnit do Gateway. Os comandos `run` e `create --run` usam os códigos de saída da execução.

| Saída | Significado |
| --- | --- |
| 0 | Gate aprovado, Replay e Live completos e sem pendências |
| 1 | Falha em verificação |
| 2 | Bloqueado, incompleto ou problema técnico |
| 130 | Cancelado |

## Evidências, retries e recuperação

Cada item fica em `qagent-results/<batchId>/<itemId>/`: `result.json`, `junit.xml`, páginas de checks/pending/network, screenshot final e trace Playwright. Strings grandes aparecem no relatório por hash/tamanho e referência à fonte; a comparação usa os valores completos. Corpos atuais diferentes de até 8 MiB são guardados como evidência; corpos maiores preservam hash/tamanho e uma pendência explícita.

`ModeResult.externalized:true` exige arrays inline vazios e `reportPages`. A soma dos `count` de cada coleção reproduz todos os registros. `checksPassed/Failed/Pending` correspondem aos status das linhas de checks; `requestsObserved` é o número de linhas da rede. O Gateway reconcilia as páginas recebidas antes da finalização.

Traces/binários maiores que 8 MiB são divididos. O manifesto `qagent.ui-execution-binary-parts.v1` informa partes em ordem, tamanho e SHA-256 total; concatene as partes e valide o hash antes de abrir o trace. Repetições de um mesmo anexo não criam referências duplicadas.

O resultado e as páginas são salvos **antes** do upload. Uma falha no envio conserva o resultado local; não transforma uma execução ocorrida em “não executada”. Retries de upload/result apenas repetem transporte idempotente. Um claim cujo ACK foi perdido não é reivindicado automaticamente de novo. Lease expirado é erro técnico; uma execução de Live não é repetida automaticamente.

Timeouts: o perfil controla passo (normalmente 7 s) e modo; o cliente usa 30 s para operações pequenas e 60 s para source/artifacts. O heartbeat continua a cada 20 s, inclusive durante leitura/envio. Esses limites operacionais encerram explicitamente trabalho que não terminou; não cortam a jornada em 512 artefatos nem omitem checks.

## Docker e integração contínua

```bash
docker build -t qagent-ui-runner:0.1.0 .
docker run --rm --init --ipc=host \
  --env-file ./private-runner/runner.env \
  -v "$PWD/private-runner:/config:ro" \
  -v "$PWD/qagent-results:/app/qagent-results" \
  qagent-ui-runner:0.1.0 \
  run --batch uieb_id_do_lote --config /config/runner.config.json
```

A pasta de saída montada precisa permitir escrita pelo usuário `pwuser` do contêiner. O exemplo de GitHub Actions está em `examples/ui-execution-ci.yml`. O workflow de verificação do próprio Runner executa os testes de contrato/transporte e a aceitação Chromium no contêiner fixado.

## Verificação desta entrega

```bash
npm run check
npm test
npm run test:browser
```

Os testes unitários cobrem integridade, escopo, query/headers/body/contexto, consumo em rajadas, JSON inválido/duplicado, locators, paginação além de 768 KiB, deduplicação, binários segmentados, transporte idempotente, cleanup de heartbeat/browser, seis ações e gates CI. O teste `browser.acceptance.js` serve uma aplicação sintética e exige que Replay use o body observado sem chamar o backend, que Live faça uma chamada real e que o contexto seja novo. Ele não é pulado nem convertido em sucesso quando Chromium não abre.

Neste ambiente de preparação do pacote, as verificações Node passaram; a aceitação com Chromium não pôde ser concluída porque o sistema bloqueou `socket()` ao abrir `/usr/bin/chromium` (`EPERM`). O Docker e a aceitação real devem passar na máquina de QA/CI antes de considerar este Runner validado para uso operacional.

Referências da implementação: [rotas e fulfill](https://playwright.dev/docs/api/class-route), [interceptação de rede](https://playwright.dev/docs/network), [Docker e compatibilidade de versão](https://playwright.dev/docs/docker).
