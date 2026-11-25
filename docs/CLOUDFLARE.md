# UI-EXEC-2 — executar o Runner no Cloudflare

O Runner `0.2.1` inclui um Worker de controle, um Durable Object e a imagem
`Dockerfile.cloudflare`. O processo Node/Playwright continua sendo o mesmo
motor usado pela CLI e pelo CI. O Gateway continua sendo a autoridade de
atribuição de itens, resultados e cancelamento.

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

## Implantação local

Pré-requisitos: Node.js 22 ou superior, conta com Workers Paid/Containers e
Docker Desktop/daemon funcionando na máquina que constrói a imagem.
`wrangler` está fixado em **4.168.0** pelo lockfile; a imagem e a dependência
Playwright estão fixadas em **1.62.1**.

Na pasta `qagent-ui-runner`:

```bash
npm ci
npm run check
npm run test:hosted
docker info
npx wrangler login
npx wrangler deploy
```

Este deploy publica o Worker e a imagem. A primeira publicação pode levar
alguns minutos até os containers estarem provisionados. O projeto não expõe
`workers.dev` nem rotas públicas; o Gateway chama o binding de serviço.
Não é necessário instalar Chromium na máquina de implantação: os binários
estão na imagem Playwright. Docker precisa estar disponível para construí-la.

Configure os dois secrets antes de disparar um lote:

```bash
npx wrangler secret put UI_RUNNER_DISPATCH_SECRET
npx wrangler secret put UI_RUNNER_SCOPES_JSON
```

### Auxiliar para gerar a configuração

O pacote inclui `scripts/configure-cloudflare.mjs`, que gera o token de
máquina, seu hash, o segredo de despacho e um perfil sem autenticação.
Use o comando completo com os IDs reais no `README-IMPLANTACAO.md` do
pacote. Exemplo de formato:

```bash
node scripts/configure-cloudflare.mjs --organization-id org_ID --project-id prj_ID --environment-id env_ID --target-base-url https://stg.example.test --profile-id profile_stg_cloudflare
npx wrangler secret bulk private-cloudflare/runner-secrets.json
```

O arquivo `private-cloudflare/gateway-secrets.json` deve ser aplicado no
projeto Gateway. Os arquivos permanecem privados e o auxiliar não imprime
seus valores nem executa deploy. A opção `--recover` conclui uma gravação
interrompida usando as credenciais já geradas.

Se já existirem perfis/tokens nesses secrets remotos, forneça seus arquivos
locais atuais com `--gateway-secrets` e `--runner-secrets` para preservar as
listas. O auxiliar não lê secrets remotos; aplicar uma lista nova substituiria
a lista daquele secret. Um perfil antigo é preservado: usar um novo ID como
`profile_stg_cloudflare` permite testar o modo sem login sem alterar um perfil
que já exige um adaptador de preparação.

`UI_RUNNER_DISPATCH_SECRET` recebe o mesmo valor no Gateway e no Runner.
`UI_RUNNER_SCOPES_JSON` recebe um array no formato abaixo. Os valores reais
são secrets; não os coloque em `wrangler.jsonc`, no repositório ou na imagem:

```json
[
  {
    "organizationId": "org_seu_escopo",
    "projectId": "prj_seu_projeto",
    "environmentId": "env_seu_ambiente",
    "apiUrl": "https://api.apiqagent.com",
    "token": "TOKEN_DE_MAQUINA_CONFIGURADO_NO_GATEWAY"
  }
]
```

O hash SHA-256 desse `token` precisa constar em
`UI_EXECUTION_TOKENS_JSON` do Gateway, no mesmo escopo, com permissões
`read` e `execute`. A permissão `create` é necessária quando o mesmo token
é usado pelo CI para criar lotes. Os secrets de HMAC entre Gateway e
`qagent-ui` continuam restritos aos serviços e não são enviados ao navegador.

O Gateway precisa do binding:

```json
{
  "services": [
    { "binding": "UI_RUNNER", "service": "qagent-ui-runner" }
  ]
}
```

Acrescente esse item à lista existente, conservando os demais bindings.
Siga também a migration e os secrets do Gateway descritos no pacote completo.

## Sem autenticação de aplicação nesta etapa

O perfil do Gateway pode usar `preparationMode: "UNAUTHENTICATED"`. Nesse
modo o navegador é aberto sem login prévio e tenta o roteiro observado.
Login exigido, acesso negado, build não confirmado e estado inicial não
preparado permanecem nos resultados; não são convertidos em aprovação.
Autenticação HTTP usada pelo runner para falar com o Gateway continua
obrigatória, independente da autenticação da aplicação testada.

Para perfis que já usam preparação confiável, o registro de escopo aceita
`configPath`, por exemplo `/app/hosted-config/runner.json`. Os módulos e a
configuração devem existir em uma imagem derivada, com os secrets fornecidos
em runtime. A imagem desta entrega usa a preparação sem autenticação e não
inclui adaptadores de login particulares de aplicações. Nenhum código
recebido em uma requisição de execução é avaliado como módulo de preparação.

## Ciclo de vida e recuperação

1. O Gateway grava o lote e sua intenção de despacho em D1.
2. O Worker verifica HMAC, escopo e configuração. Um Durable Object por
   escopo/lote persiste a intenção e um alarme antes de responder `202`.
3. O alarme verifica o estado do lote no Gateway e inicia o container quando
   ainda houver trabalho. O status de prontidão é confirmado pela porta 8080.
4. `/run` inicia `Worker.runBatch()` uma única vez naquele processo.
   Cada item ainda precisa de um claim exclusivo concedido pelo Gateway.
5. Alarmes a cada 30 segundos inspecionam o runtime. O Gateway também pode
   reenviar o despacho; o mesmo lote não cria outro executor concorrente no DO.
6. Ao finalizar, o controlador confirma o estado terminal no Gateway,
   envia `SIGTERM` e encerra a instância. Uma próxima entrega do mesmo despacho
   não reexecuta o lote finalizado.

O timeout de inatividade é de 10 minutos; os alarmes e despachos renovam o
trabalho do controlador. A prontidão inicial tem prazo de 120 segundos. Uma
falha isolada na leitura de saúde não interrompe um lote já em execução.
O encerramento planejado permite 30 segundos ao processo; o servidor Node
reserva até 25 segundos para encerrar e publicar o que conseguir.

Se a porta de controle **e** o Gateway ficarem inalcançáveis continuamente
por cinco minutos, o runtime é encerrado com
`UI_RUNNER_INFRASTRUCTURE_UNREACHABLE`. Uma resposta válida de qualquer um
reinicia essa contagem. Esse watchdog é da infraestrutura, não um timeout
de API da aplicação; a tentativa não é aprovada nem reiniciada. Caso o
runtime já tenha terminado, mas o Gateway esteja indisponível, o container
também pode encerrar e o controlador mantém `RECOVERING`, consultando D1
sem manter um navegador ocioso ligado. O estado terminal do lote só é
confirmado pelo Gateway.

O container recebe somente o token e a configuração do seu escopo. O token
interno da porta de controle é gerado por inicialização; essa porta não
fornece arquivos nem executa comandos arbitrários. O disco local é temporário.
Páginas e evidências publicadas no Results Plane permanecem no R2; dados que
ainda não chegaram ao serviço quando ocorre uma interrupção abrupta não são
declarados preservados. A execução permanece incompleta nesse caso.

Depois de um erro do processo, um novo runtime consulta os mesmos itens em
D1. Ele só recebe trabalho ainda elegível; não existe reset automático de uma
tentativa Live iniciada. Perda de lease é um erro técnico da tentativa.
`SIGTERM` da hospedagem usa `UI_RUNNER_HOST_SHUTDOWN`, sem fingir que o
usuário cancelou o teste.

Há até cinco instâncias `standard-1` simultâneas na configuração inicial.
Cada processo executa um item por vez. O limite é de compute simultâneo,
não de número de observações/artefatos na jornada. O envio e a reconciliação
do Gateway mantêm lotes aguardando capacidade. A configuração usa a política
de scheduling `default`; deployments de imagem podem reciclar instâncias.
Evite atualizar a imagem durante um lote que esteja usando um estado Live
compartilhado. Um teste interrompido não vira sucesso nem é repetido sozinho.

## Diagnóstico e teste hospedado

```bash
npx wrangler containers list
npx wrangler tail qagent-ui-runner --format pretty
```

Teste de aceitação após provisionamento:

1. Abra Automação, selecione ambiente e perfil sem autenticação e informe
   o build que pretende testar.
2. Dispare o lote UI ou o comando conjunto API + UI.
3. Feche a página e abra novamente; o lote deve continuar disponível.
4. Verifique Replay e Live separadamente e baixe as evidências publicadas.
5. Execute uma tentativa de cancelamento e confirme que itens em execução
   terminam com sua evidência parcial, sem continuação no modo seguinte.

Uma página de login/401/403 é um resultado esperado enquanto a autenticação
do ambiente não estiver integrada. Um erro de configuração do token entre
serviços é um problema de infraestrutura e aparece separadamente.

## Verificação realizada na preparação desta entrega

- Testes do protocolo HMAC e escopo, recuperação de DO, despacho duplicado,
  processo terminal, erro técnico, cancelamento e controle Node passaram.
- O bundle do Worker e a configuração Wrangler foram validados com
  `wrangler deploy --dry-run --containers-rollout=none`.
- O dry-run completo requer Docker, indisponível no ambiente de preparação.
  A imagem não foi construída/publicada aqui.
- Chromium real e execução no Cloudflare precisam ser validados no ambiente
  de implantação. Os testes de controlador usam uma implementação simulada
  de Container; não são uma prova de execução real de browser.

Referências oficiais consultadas:

- https://developers.cloudflare.com/containers/get-started/
- https://developers.cloudflare.com/containers/api/durable-object-container/
- https://developers.cloudflare.com/containers/concepts/architecture/
- https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/
