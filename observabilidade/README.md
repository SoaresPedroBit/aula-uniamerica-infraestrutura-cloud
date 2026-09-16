# Observabilidade

Painéis, métricas e cenários de teste da infraestrutura `200status`. Este arquivo cobre
apenas a **operação**: o que existe, como recriar e como testar. A fundamentação de cada
painel fica em documento separado.

```
observabilidade/
  metrics/      definições das log-based metrics (YAML da API do Cloud Logging)
  uptime/       definições dos uptime checks (JSON da API do Cloud Monitoring)
  dashboards/   definição do dashboard (JSON da API do Cloud Monitoring)
  scripts/      provisionamento e cenários de teste
```

As definições são versionadas porque um painel construído a cliques no console não é
reproduzível: não se sabe o que mudou, nem como voltar atrás.

---

## Recriar tudo do zero

```bash
bash observabilidade/scripts/provisionar.sh
```

Cria as cinco log-based metrics, os dois uptime checks, o dashboard e a permissão de escrita
do proxy. É idempotente por omissão: o que já existe é apenas reportado, nunca sobrescrito.
Para atualizar uma definição, apague o recurso e rode de novo.

**Ordem importa.** Log-based metrics contam apenas os registros gravados *depois* da criação.
Provisione antes de gerar carga, senão os painéis nascem vazios.

Dashboard: <https://console.cloud.google.com/monitoring/dashboards?project=mensal2>

---

## O que alimenta os painéis

| Origem | Como chega ao Cloud Logging | Vira |
|---|---|---|
| `backend/observabilidade.js` | linha JSON no stdout, que o Cloud Run converte em `jsonPayload` | `app_request_count`, `app_request_duration_ms`, `app_db_operation_count`, `app_db_operation_duration_ms` |
| `proxy/lib/observabilidade.js` | `POST logging.googleapis.com/v2/entries:write`, autenticado pelo token federado | `proxy_upstream_requests` |
| Uptime checks | métrica nativa do Monitoring | painel 1 |
| Plataforma (Cloud Run) | métricas nativas, sem instrumentação | painéis 7 (RAM, CPU, instâncias) |
| Plataforma (Firestore) | métricas nativas, sem instrumentação | painel 8 (armazenamento, operações) |

Dois eventos saem do back-end por requisição, ligados pelo mesmo `request_id` (o trace do
Cloud Run): `http_request` e um `db_operation` por operação no Firestore.

Os painéis 7 e 8 não dependem de log algum: consomem métricas que a plataforma já publica.
Por isso continuam preenchidos mesmo que a instrumentação da aplicação pare — e é essa
independência que os torna úteis para diagnosticar a própria coleta.

### Dois recursos monitorados para o mesmo banco

As métricas do Firestore estão divididas em dois `resource.type`, e trocá-los devolve
"filtro não especifica uma combinação válida":

| Métrica | `resource.type` |
|---|---|
| `storage/data_and_index_storage_bytes` | `firestore.googleapis.com/Database` |
| `document/read_count`, `write_count`, `delete_count` | `firestore_instance` |

Cada requisição à API de `timeSeries` aceita **um único** `metric.type`. Somar leituras,
escritas e exclusões num gráfico exige três `dataSets`, não um filtro `one_of`.

### A permissão do proxy tem uma sutileza

O proxy escreve no Cloud Logging com o **token de acesso federado**, que representa o
`principal://` do Workload Identity Pool — **não** a `proxy-sa`. A impersonação só acontece
depois, para gerar o token de identidade do Cloud Run. Conceder `roles/logging.logWriter` à
service account, portanto, **não funciona**: a escrita ocorre antes da impersonação e recebe
403 silencioso. O papel vai para o principal federado. O `provisionar.sh` já faz isso.

Sintoma de que algo quebrou nessa cadeia: o painel 6 vazio. Diagnóstico rápido — o cabeçalho
`X-Obs-Entrega` da resposta do proxy diz se o registro chegou a ser produzido:

```bash
curl -s -D - -o /dev/null https://200status.soarespedro.com.br/ | grep -i x-obs
```

`waitUntil` ou `await` significam que o proxy produziu o registro (o problema é permissão ou
ingestão); ausência do cabeçalho significa que o código novo não está publicado.

---

## Cenários de teste

| Script | O que faz | Painéis que valida |
|---|---|---|
| `carga.sh [n]` | uso normal pelo domínio: as quatro operações, mais um 400 e um 404 previstos pela própria aplicação | 2, 3, 4, 5 |
| `falha-banco.sh` | remove `roles/datastore.user` da `backend-sa`, gera requisições, restaura | 3 (5xx reais), 5 (`result=error`) |
| `falha-regiao.sh` | põe uma revisão que responde 503 em São Paulo, envia todo o tráfego da região para ela, restaura | 6 (`failover=true`) |

Os dois cenários de falha **alteram produção** e restauram ao final, inclusive se
interrompidos (`trap ... EXIT`). O `falha-banco.sh` confirma a restauração por resultado, não
por relógio: a propagação do IAM leva cerca de dois minutos, e as instâncias já em execução
mantêm a credencial anterior em cache.

Após `falha-regiao.sh`, remova a revisão defeituosa:

```bash
gcloud run revisions list --service=frontend --region=southamerica-east1
gcloud run revisions delete <revisao> --region=southamerica-east1
```

---

## Retenção e custo

Logs ficam no bucket `_Default`, retidos **30 dias**. As métricas derivadas deles têm
retenção própria de **24 meses** — ou seja, os painéis continuam mostrando o histórico depois
que os registros brutos originais já expiraram, mas a partir daí não é mais possível descer
ao log individual que produziu um ponto.

Tudo permanece dentro da cota gratuita: 50 GiB/mês de ingestão no Logging, 1 milhão de
execuções de uptime check. O check da API faz cerca de 1.700 leituras diárias no Firestore,
contra a cota de 50 mil/dia. O alerta de orçamento de R$ 1,00 do projeto continua valendo.
