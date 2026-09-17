# Dossiê técnico — 200status

Documento de repasse. Reúne o que existe hoje no ambiente, como cada peça foi configurada, o
que já foi comprovado por teste e o que continua em aberto. **Não é a documentação da
entrega** — é a matéria-prima para escrevê-la.

Atualizado em **17/09/2026**, após a migração do proxy reverso da Vercel para o Load Balancer
da GCP.

> **Regra ao usar este documento:** tudo que aparece como "observado" foi medido no ambiente
> real e a data está indicada. O que ainda não foi testado está marcado como pendente — não o
> converta em afirmação na documentação final sem executar o teste.

---

## 1. Visão geral

Aplicação de lista de tarefas (React + Express + Firestore) rodando em infraestrutura
serverless no Google Cloud, acessível apenas por domínio próprio, com front-end redundante em
duas regiões.

| | |
|---|---|
| Front-end | `https://200status.soarespedro.com.br` |
| API | `https://api.200status.soarespedro.com.br` |
| Projeto GCP | `mensal2` (número `1076166965572`) |
| IP público do balanceador | `34.8.14.154` |
| Repositório | `github.com/SoaresPedroBit/aula-uniamerica-infraestrutura-cloud` |

### Fluxo das requisições

```
Usuário → DNS (Hostinger) → Load Balancer GCP → Cloud Run front-end (2 regiões)
Front-end → DNS/API → Load Balancer GCP → Cloud Run back-end → Firestore
```

Ambos os fluxos entram pelo **mesmo IP** e são separados pelo cabeçalho `Host` no URL map.

---

## 2. O que mudou nesta versão, e por quê

A versão anterior usava um **proxy reverso serverless na Vercel**, que lia o `Host`,
obtinha um token de identidade do Google por Workload Identity Federation (sem nenhuma chave
armazenada) e encaminhava para os Cloud Run, todos privados. O professor pediu a troca por um
proxy reverso convencional com o Load Balancer da GCP.

**A troca não é de peça equivalente — muda a natureza do controle de acesso**, e este é
provavelmente o ponto mais importante a explicar na documentação:

| | Antes (proxy Vercel) | Agora (Load Balancer) |
|---|---|---|
| Como o Cloud Run era protegido | `--no-allow-unauthenticated`: cada requisição provava identidade | `--allow-unauthenticated` + `ingress=internal-and-cloud-load-balancing` |
| Natureza do controle | **Identidade** (IAM) | **Rede** (origem do tráfego) |
| Quem podia invocar | só a `proxy-sa`, via token OIDC federado | qualquer chamada vinda do balanceador |
| O que barra a Internet | o serviço recusava com 403 | o ingress recusa com 404 |
| Failover entre regiões | código no handler, dentro da mesma requisição | `outlierDetection` no backend service |

**Por que o `--allow-unauthenticated` foi inevitável:** serverless NEGs não enviam token de
identidade ao Cloud Run. Com o serviço privado, o balanceador recebe 403 e nada funciona. O
caminho suportado pela Google é abrir a invocação no nível do IAM e fechar a rede pelo ingress.

**O que *não* mudou:** o banco. O Firestore continua acessível exclusivamente pela
`backend-sa` via IAM, sem endpoint de rede público. Essa camada manteve a proteção por
identidade em todas as versões.

---

## 3. Domínio e DNS

Domínio `soarespedro.com.br` registrado no Registro.br, com zona DNS na **Hostinger**
(nameservers `ns1.dns-parking.com` / `ns2.dns-parking.com`).

| Tipo | Nome | Valor | Serve |
|---|---|---|---|
| A | `200status` | `34.8.14.154` | front-end |
| A | `api.200status` | `34.8.14.154` | API |

A configuração é **aditiva**: o apex e o `www` continuam servindo outro site do grupo e não
foram tocados em nenhuma das versões.

**Registros anteriores (removidos em 16/09/2026):** dois CNAME para
`2c85b3ee133dd835.vercel-dns-017.com`.

### TLS

Dois certificados gerenciados pelo Google, um por domínio:

| Certificado | Domínio | Status | Emissor |
|---|---|---|---|
| `cert-front` | `200status.soarespedro.com.br` | `ACTIVE` | Google Trust Services, CN=WR3 |
| `cert-api` | `api.200status.soarespedro.com.br` | `ACTIVE` | Google Trust Services, CN=WR3 |

Validade observada: `16/09/2026` a `16/12/2026`, com renovação automática.

> **Por que dois certificados e não um com os dois domínios.** A primeira tentativa foi um
> certificado único (`cert-200status`, ainda existe no projeto como resíduo, em
> `PROVISIONING`). Um certificado gerenciado só fica `ACTIVE` quando **todos** os seus
> domínios validam. Como o cache do resolvedor do Google liberou os dois subdomínios em
> momentos diferentes, o certificado único ficaria travado pelo mais lento. Separando, cada
> domínio ativa assim que puder. **Esse certificado órfão pode ser removido.**

---

## 4. Inventário dos recursos no GCP

### Cloud Run

| Serviço | Região | Service account | Ingress | Invocação |
|---|---|---|---|---|
| `backend` | `southamerica-east1` | `backend-sa` | `internal-and-cloud-load-balancing` | `allUsers` |
| `frontend` | `southamerica-east1` | `frontend-sa` | `internal-and-cloud-load-balancing` | `allUsers` |
| `frontend` | `us-central1` | `frontend-sa` | `internal-and-cloud-load-balancing` | `allUsers` |

Limites por instância: **512 MiB de memória, 1 vCPU**. Escala mínima zero.

### Load Balancer (Application Load Balancer externo global)

| Componente | Nome | Observação |
|---|---|---|
| IP estático global | `ip-200status` | `34.8.14.154` |
| Regra de encaminhamento 443 | `fr-https-200status` | → `proxy-https-200status` |
| Regra de encaminhamento 80 | `fr-http-200status` | → `proxy-http-200status` |
| Proxy HTTPS | `proxy-https-200status` | certificados `cert-front` + `cert-api` |
| Proxy HTTP | `proxy-http-200status` | → URL map de redirecionamento |
| URL map principal | `urlmap-200status` | roteia por `Host` |
| URL map de redirect | `urlmap-redirect-200status` | 301 para HTTPS |
| Backend service front | `bs-frontend` | 2 NEGs + `outlierDetection` |
| Backend service API | `bs-backend` | 1 NEG |
| NEGs | `neg-frontend-rj`, `neg-frontend-uc`, `neg-backend-rj` | tipo `SERVERLESS` |

Roteamento do URL map:

| Host | Destino |
|---|---|
| `api.200status.soarespedro.com.br` | `bs-backend` |
| `200status.soarespedro.com.br` e default | `bs-frontend` |

### Banco de dados

Firestore em modo Native, banco `(default)`, região `southamerica-east1`. Coleção `todos`.
Sem endpoint de rede público — o acesso é exclusivamente por IAM.

### Identidades e permissões

| Identidade | Papel | Escopo |
|---|---|---|
| `backend-sa` | `roles/datastore.user` | projeto — único acesso ao banco |
| `frontend-sa` | nenhum | serve arquivos estáticos, não precisa de nada |
| `allUsers` | `roles/run.invoker` | nos 3 serviços — exigido pelo balanceador |
| `proxy-sa` | `roles/run.invoker` | **resíduo da versão anterior, deve ser removido** |
| principal federado (WIF) | `roles/logging.logWriter` | **resíduo, deve ser removido** |

---

## 5. Segurança: o que é permitido e o que é bloqueado

| Origem → destino | Porta | Protocolo | Resultado |
|---|---|---|---|
| Usuário → LB | 443 | HTTPS / TLS 1.2+ | ✅ permitido |
| Usuário → LB | 80 | HTTP | ✅ 301 → HTTPS |
| LB → Cloud Run (3 serviços) | 443 | HTTPS interno da Google | ✅ permitido |
| Navegador → API pelo domínio | 443 | HTTPS | ✅ permitido (CORS restrito) |
| Back-end → Firestore | 443 | HTTPS + IAM | ✅ permitido |
| Internet → `backend-*.run.app` | 443 | HTTPS | ❌ **404** (ingress) |
| Internet → `frontend-*-rj.run.app` | 443 | HTTPS | ❌ **404** (ingress) |
| Internet → `frontend-*-uc.run.app` | 443 | HTTPS | ❌ **404** (ingress) |
| Internet → Firestore | — | — | ❌ sem rota pública |
| `frontend-sa` → Firestore | — | — | ❌ sem permissão IAM |
| Origem web fora do domínio → API | 443 | HTTPS | ❌ CORS recusa |

CORS: o back-end aceita apenas `https://200status.soarespedro.com.br`, via variável de
ambiente `ALLOWED_ORIGIN` (`backend/index.js:20-24`).

> **Nota para o diagrama.** O bloqueio agora é **404, não 403**. A diferença importa: 403
> significava "sei quem você é e você não pode"; 404 significa "esta porta não existe para
> quem vem de fora". O ponto de bloqueio deixou de ser o IAM do serviço e passou a ser o
> ingress, na borda da rede.

---

## 6. Redundância — o ponto mais delicado da entrega

O front-end roda em **duas regiões**: `southamerica-east1` (primária por proximidade) e
`us-central1`. Ambas servem a mesma imagem e estão no mesmo backend service.

### Como funciona, e por que precisou de configuração extra

O balanceador envia cada requisição para a **região mais próxima do usuário**. Ele não faz
failover sozinho, e a documentação da Google é explícita em dois pontos:

> *"Health checks are not supported for serverless backends."*
> *"Even if your resource is returning errors, the load balancer continues to direct traffic to it."*

Health check clássico não existe aqui porque o Cloud Run não expõe instâncias para sondar. O
substituto configurado é o **`outlierDetection`** em `bs-frontend`:

```yaml
outlierDetection:
  consecutiveErrors: 3        # 3 respostas 5xx seguidas ejetam a região
  interval: {seconds: 10}
  baseEjectionTime: {seconds: 30}
  maxEjectionPercent: 50      # nunca ejeta as duas ao mesmo tempo
```

**Sem esse bloco não haveria redundância alguma**, e a falha seria silenciosa: em operação
normal tudo pareceria correto.

### A regressão em relação à versão anterior

Vale registrar honestamente na documentação: **neste aspecto a arquitetura nova é menos capaz
que a antiga.** O proxy da Vercel tratava o 503 dentro do mesmo ciclo da requisição, e o
usuário nunca via erro — comprovado em 15/09/2026, com 8 de 8 requisições em HTTP 200 durante
a falha. Com `outlierDetection`, a detecção é passiva: os primeiros erros **chegam ao
usuário** antes da ejeção.

A alternativa que evitaria isso é o *Cloud Run service health* (readiness probes agregadas por
região), descartada porque **exige `min-instances >= 1` em cada região**, o que mantém
contêineres de pé 24 horas por dia e elimina o custo zero do Cloud Run.

### Como a região é identificada

O balanceador **não oferece variável de cabeçalho** que revele o backend escolhido —
`{backend_scope}` existe apenas nos logs e é recusado em `customResponseHeaders`. A solução
foi cada serviço carimbar a própria região:

- **Front-end:** `frontend/default.conf.template`, processado por `envsubst` na partida do
  nginx, com a variável `REGION` definida no deploy de cada região.
- **Back-end:** `res.setHeader('X-Origem-Regiao', REGIAO)` no middleware
  (`backend/observabilidade.js`).

Isso é mais fiel do que um cabeçalho do balanceador: registra **quem executou**, não quem o
balanceador acredita ter escolhido.

---

## 7. Observabilidade

Oito painéis no Cloud Monitoring, dashboard **"200status - Observabilidade"**.
Definições versionadas em `observabilidade/`.

> ⚠️ **O dashboard é editado por mais de uma pessoa, inclusive pelo console.** Nunca use
> `dashboards delete` + `create` — isso descarta as edições dos outros sem aviso e sem
> recuperação. O procedimento seguro (`describe` → editar → `update`) está em
> `observabilidade/README.md`.

| # | Painel | Pergunta | Fonte |
|---|---|---|---|
| 1 | Disponibilidade | responde pelo domínio? | 2 uptime checks, 4 regiões, 5 min |
| 2 | Desempenho | o que demora mais? | `app_request_duration_ms` (log) |
| 3 | Erros | quais falhas, que parcela? | `app_request_count` por `status_class` |
| 4 | Uso | quais funcionalidades? | mesmo contador, filtrado por `client="app"` |
| 5 | Banco | operações funcionam, em quanto tempo? | `app_db_operation_*` (log) |
| 6 | Redundância | como se comportam na falha? | **métrica nativa do LB**, label `backend_scope` |
| 7 | Saturação | há folga de RAM e CPU? | métricas de plataforma do Cloud Run |
| 8 | Consumo do banco | quanto ocupa e consome da cota? | métricas de plataforma do Firestore |

### Logs estruturados

O back-end emite duas linhas JSON por requisição, correlacionadas pelo mesmo `request_id` (o
trace do Cloud Run), em `backend/observabilidade.js`:

- `event=http_request` — `method`, `route` (**padronizada**: `/todos/:id`, nunca o ID
  concreto), `operation` (nome de negócio), `status`, `status_class`, `duration_ms`, `client`
- `event=db_operation` — `operation`, `collection`, `result`, `duration_ms`, e em falha
  `error_type` (código gRPC) e `error_message`

O rótulo `client` separa `app` de `uptime` e `bot` — sem ele, o painel de uso mediria o
próprio monitoramento.

**Não são registrados:** senhas, tokens, credenciais, nem o texto das tarefas do usuário.

Retenção: logs no bucket `_Default` por **30 dias**; métricas derivadas por **24 meses**.

### Mudança nesta versão

O painel 6 era alimentado pelos logs que o proxy da Vercel escrevia no Cloud Logging
(`proxy_upstream_requests`). Sem o proxy, essa fonte seca. A substituta é a **métrica nativa
do balanceador** (`loadbalancing.googleapis.com/https/backend_request_count`), cujo rótulo de
recurso `backend_scope` já informa a região que atendeu — sem log a coletar, extrair ou reter.

A métrica antiga não foi apagada: os dados do teste de failover de 15/09 continuam válidos e
retidos por 24 meses.

> Na série do painel 6 aparece `NO_BACKEND_SELECTED`. **É legítimo**: são os
> redirecionamentos 80 → 443, respondidos pelo próprio balanceador sem chegar a backend algum.

---

## 8. Evidências já coletadas

Arquivos brutos em `observabilidade/evidencias/`.

### Com o Load Balancer (17/09/2026)

| Verificação | Resultado observado |
|---|---|
| Front-end pelo domínio | `HTTP 200`, `x-origem-regiao: us-central1` |
| API pelo domínio | `HTTP 200`, `x-origem-regiao: southamerica-east1` |
| Porta 80 | `301` → `https://200status.soarespedro.com.br:443/` |
| Certificado | `CN=200status.soarespedro.com.br`, Google Trust Services WR3 |
| CRUD completo pelo domínio | `GET 200`, `POST 201`, `PATCH 200`, `DELETE 200` |
| Acesso direto `.run.app` (3 URLs) | **404** nas três, após fechar o ingress |
| Aplicação após fechar o ingress | `200` no domínio, escrita e remoção reais no Firestore |

### Com a versão anterior (15/09/2026) — ainda válidas para os painéis 2 a 5

| Cenário | Resultado |
|---|---|
| Carga normal, 12 repetições | 97 `2xx`, 44 `4xx` (400 e 404 previstos pela aplicação) |
| Uso por operação | 36 criar, 36 concluir, 18 excluir, 23 listar |
| Separação de tráfego | 113 `client=app` contra 20 `client=uptime` |
| Falha do banco (IAM revogado) | **7 respostas `5xx`**, 15 `db_operation` com `error_type=7` (PERMISSION_DENIED) |
| Desempenho | p95 por operação; cauda de 1.996 ms em `listar_tarefas` (partida a frio) |
| Saturação | RAM: back-end 21%, front-end 7% do limite; CPU ~2% |
| Consumo do banco | 2.476 bytes armazenados; 629 leituras / 36 escritas / 18 exclusões em 2 h |
| Failover **com o proxy Vercel** | 24 requisições `failover=true` por `us-central1`, 26 recusas da primária, **zero erros ao usuário** |

---

## 9. Pendências — o que ainda NÃO foi feito

### 9.1 Teste de failover com o Load Balancer ⚠️

**Não executado.** O cenário com o proxy da Vercel está comprovado, mas o `outlierDetection`
ainda não foi exercitado. **Não afirme na documentação que o failover funciona antes de rodar
este teste.**

```bash
bash observabilidade/scripts/falha-regiao.sh
```

O script implanta uma revisão que responde 503 em São Paulo, conta quantas requisições
receberam erro antes da ejeção, verifica a virada para `us-central1` e restaura tudo ao final
(inclusive se interrompido). Se a ejeção não ocorrer, ajustar `consecutiveErrors` e `interval`
em `infra/load-balancer/backend-service-frontend.yaml` — ou registrar a limitação, sem omiti-la.

### 9.2 Limpeza da cadeia de identidade da Vercel

Resíduos ainda ativos, sem uso:

```bash
# 1. remover o invoker da proxy-sa nos três serviços
gcloud run services remove-iam-policy-binding backend --region=southamerica-east1 \
  --member=serviceAccount:proxy-sa@mensal2.iam.gserviceaccount.com --role=roles/run.invoker
# (repetir para frontend em southamerica-east1 e us-central1)

# 2. remover o logWriter do principal federado
# 3. remover o Workload Identity Pool "vercel"
# 4. remover a service account proxy-sa
# 5. desconectar o projeto na Vercel (manual, no painel)
# 6. remover o certificado órfão cert-200status
```

Credencial que não é mais usada e continua válida é risco puro.

### 9.3 Diagrama e documentação de infraestrutura

`diagrama-arquitetura.html` e `doc/documentacao-infraestrutura.md` descrevem a arquitetura
**anterior** (proxy Vercel, WIF, bloqueio por 403). Estão incorretos e precisam ser refeitos.

### 9.4 Fundamentação dos painéis

A atividade de observabilidade exige, para **cada** painel: pergunta operacional, motivo da
escolha, origem dos dados, consulta e cálculo, recorte temporal, forma de visualização,
interpretação, critérios de atenção, ação decorrente, validação e limitações. Os painéis
existem e funcionam; a fundamentação escrita não foi feita.

### 9.5 Custo — atenção 💰

**O projeto deixou de ser gratuito em 16/09/2026.** As regras de encaminhamento custam
**~US$ 0,025/hora (~US$ 18/mês)** mesmo sem tráfego, mais o processamento de dados. O Cloud
Run, o Firestore e a observabilidade continuam dentro das cotas gratuitas.

Desmontar após a apresentação:

```bash
bash infra/load-balancer/teardown.sh   # pede confirmação digitada
```

O alerta de orçamento de R$ 1,00 do projeto continua ativo e vai disparar.

---

## 10. Achados técnicos não óbvios

Material útil para justificar decisões na documentação — todos verificados no ambiente.

1. **Serverless NEG não aceita `--protocol` no backend service.** Gera `portName`, recusado
   com *"Port name is not supported for a backend service with Serverless network endpoint
   groups"*.
2. **`{backend_scope}` não funciona em `customResponseHeaders`** — existe só nos logs. Nenhuma
   variável de cabeçalho revela o backend escolhido.
3. **O Cloud Monitoring não soma amostras de uma distribution entre séries.** Por isso existem
   contadores separados (`app_request_count`, `app_db_operation_count`) ao lado das
   distribuições de duração.
4. **As métricas do Firestore usam dois `resource.type` diferentes**: armazenamento em
   `firestore.googleapis.com/Database`, contagem de documentos em `firestore_instance`.
   Trocá-los devolve erro de combinação inválida.
5. **Cada consulta de `timeSeries` aceita um único `metric.type`** — somar leituras, escritas
   e exclusões exige três `dataSets`, não um filtro `one_of`.
6. **A propagação do IAM leva ~2 minutos**, e instâncias já em execução mantêm a credencial
   anterior em cache. Por isso `falha-banco.sh` confirma a restauração por resultado, e não
   por tempo fixo.
7. **O resolvedor do Google responde de forma inconsistente durante a propagação** — nós de
   cache diferentes devolvem respostas diferentes para o mesmo nome. Foi o que fez a validação
   do certificado oscilar entre `PROVISIONING` e `FAILED_NOT_VISIBLE` por cerca de 3 horas.
8. **O Cloud Run não permite apagar a revisão mais recente** de um serviço. Para remover uma
   revisão de teste é preciso implantar outra antes.
9. **Na versão anterior, o `logging.logWriter` precisava ir para o principal federado, não
   para a `proxy-sa`** — o token do STS representa o principal do pool, e a impersonação só
   acontece depois. Conceder à service account resultava em 403 silencioso.
10. **`POST /todos` devolve 400 quando o banco falha**, não 500 — o `catch` da rota é
    pré-existente na aplicação. A instrumentação expôs um erro de servidor mascarado como erro
    de cliente. Não foi corrigido, por estar fora do escopo.

---

## 11. Comandos de verificação

```bash
# entrada pelos domínios
curl -sI https://200status.soarespedro.com.br/
curl -sI https://api.200status.soarespedro.com.br/todos
curl -sI http://200status.soarespedro.com.br/           # espera 301

# qual região atendeu
curl -s -D - -o /dev/null https://200status.soarespedro.com.br/ | grep -i x-origem-regiao

# bloqueio do acesso direto (espera 404 nas três)
curl -s -o /dev/null -w '%{http_code}\n' https://backend-lnjz6zmyda-rj.a.run.app/todos
curl -s -o /dev/null -w '%{http_code}\n' https://frontend-lnjz6zmyda-rj.a.run.app/
curl -s -o /dev/null -w '%{http_code}\n' https://frontend-lnjz6zmyda-uc.a.run.app/

# estado do balanceador e dos certificados
gcloud compute forwarding-rules list --global
gcloud compute ssl-certificates list --format='value(name,managed.status)'
gcloud compute backend-services describe bs-frontend --global --format='yaml(outlierDetection)'

# ingress dos serviços
gcloud run services describe backend --region=southamerica-east1 \
  --format="value(metadata.annotations['run.googleapis.com/ingress'])"

# logs estruturados
gcloud logging read 'jsonPayload.event="http_request"' --limit=3 --format=json
gcloud logging read 'jsonPayload.event="db_operation"' --limit=3 --format=json

# carga controlada (gera dados para os painéis 2, 3, 4 e 5)
bash observabilidade/scripts/carga.sh 12
```

---

## 12. Mapa dos arquivos

```
infra/load-balancer/
  criar.sh                        monta o LB inteiro (idempotente)
  teardown.sh                     desmonta (pede confirmação digitada)
  fechar-ingress.sh               fecha/abre o ingress; imprime a prova do bloqueio
  backend-service-frontend.yaml   inclui o outlierDetection
  backend-service-backend.yaml
  urlmap-redirect.yaml            redirecionamento 80 → 443

observabilidade/
  README.md                       operação, e o procedimento seguro do dashboard
  metrics/*.yaml                  5 log-based metrics
  uptime/*.json                   2 uptime checks
  dashboards/*.json               molde do dashboard (a fonte da verdade é o servidor)
  scripts/                        provisionar, carga, falha-banco, falha-regiao
  evidencias/                     logs e saídas brutas dos testes

backend/
  index.js                        4 rotas REST, CORS restrito, porta do ambiente
  observabilidade.js              logger estruturado, middleware, medição do banco

frontend/
  src/App.js                      URL da API por variável de build
  .env.production                 aponta para o domínio da API
  default.conf.template           nginx com REGION via envsubst
  Dockerfile                      build do React + nginx

proxy/                            solução anterior (Vercel + WIF), mantida como histórico
doc/documentacao-infraestrutura.md   DESATUALIZADO — descreve a arquitetura anterior
```
