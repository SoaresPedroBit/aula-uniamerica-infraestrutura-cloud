# Infraestrutura 200status

Documentação da infraestrutura serverless construída para a aplicação de lista de tarefas:
quais serviços foram usados e por quê, como cada camada é protegida, como a redundância e o
proxy reverso funcionam, e o que os testes comprovaram.

| | |
|---|---|
| Front-end | `200status.soarespedro.com.br` |
| API | `api.200status.soarespedro.com.br` |
| Projeto GCP | `mensal2` |

---

## 1. Visão geral

A aplicação tem três componentes: um front-end React compilado para arquivos estáticos, um
back-end Express com quatro rotas REST, e um banco de dados. Nenhum deles é acessível
diretamente pela Internet. Toda requisição legítima entra por um único ponto — o proxy
reverso — que termina o TLS no domínio próprio e assina a identidade sem a qual nenhum
serviço do Google Cloud responde.

```
Usuário    →  DNS      →  Proxy reverso  →  Front-end (2 regiões)
Front-end  →  DNS/API  →  Proxy reverso  →  Back-end  →  Banco de dados
```

A decisão central do projeto é que **o controle de acesso é feito por identidade, não por
endereço de rede**. Não há regra de firewall liberando faixas de IP: cada camada exige um
token que prova quem está chamando. Isso continua valendo mesmo que um endereço interno
vaze, o que não seria verdade numa proteção baseada em IP.

---

## 2. Serviços utilizados e por quê

| Camada | Serviço | Por que este |
|---|---|---|
| Domínio | Registro.br — `soarespedro.com.br` | Domínio já pertencente ao grupo, o que dispensou pedir subdomínio ao professor |
| DNS | Hostinger | Já era o provedor autoritativo. Manter a zona onde estava permitiu acrescentar os dois subdomínios **sem tocar no site que já rodava no apex**, evitando janela de indisponibilidade |
| Proxy reverso | Vercel — função serverless | Serverless, TLS gerenciado grátis, e emite tokens OIDC próprios — o que permitiu autenticar no Google sem nenhuma chave armazenada |
| Front-end | Cloud Run — 2 regiões | Serverless com escala a zero. Duas regiões dão os dois pontos de atendimento exigidos, e a falha de uma é demonstrável de forma controlada |
| Back-end | Cloud Run — `southamerica-east1` | Mesma plataforma, com invocação restrita por IAM em vez de exposição pública |
| Banco | Firestore — modo Native | Gerenciado e serverless, mas o motivo decisivo é que **não expõe endereço de rede algum**: o acesso é exclusivamente por IAM, o que elimina a superfície pública em vez de apenas protegê-la |
| Build | Cloud Build + Artifact Registry | Constroem a imagem a partir do código-fonte, sem necessidade de Docker na máquina de quem faz o deploy |

> **Por que Firestore e não MongoDB gerenciado.**
> A aplicação original usa MongoDB. O Atlas, equivalente gerenciado, só oferece endpoint
> privado a partir do plano M10, com custo mensal relevante; nos planos gratuitos o banco
> fica acessível pela Internet, protegido apenas por usuário e senha. Como o requisito era
> *não possuir acesso público*, trocamos a camada de dados por Firestore e reescrevemos as
> quatro rotas. O contrato JSON permaneceu idêntico, então o front-end não precisou de
> nenhuma adaptação.

---

## 3. Como o domínio foi configurado

O domínio já servia um site do grupo na Vercel, no apex e no `www`. Por isso a configuração
foi **aditiva**: nenhum registro existente foi alterado, e os nameservers continuaram na
Hostinger. Foram criados apenas dois registros CNAME.

| Tipo | Nome | Aponta para | Serve |
|---|---|---|---|
| CNAME | `200status` | `2c85b3ee133dd835.vercel-dns-017.com` | Front-end |
| CNAME | `api.200status` | `2c85b3ee133dd835.vercel-dns-017.com` | API |

O certificado TLS de cada subdomínio é emitido e renovado pela Vercel automaticamente.
Requisições em texto claro na porta 80 recebem redirecionamento `308` para HTTPS.

> **Por que um CNAME direto para o Cloud Run não funcionaria.**
> O Cloud Run roteia por cabeçalho `Host`. Uma requisição chegando com
> `Host: 200status.soarespedro.com.br` não corresponde a serviço algum e recebe `404` —
> comprovado em teste. Além disso, o certificado de `*.a.run.app` não cobre o domínio
> próprio. O recurso oficial para isso, *domain mapping*, está em preview, não existe em
> `southamerica-east1` e exigiria tornar os serviços públicos, o que quebraria o requisito
> de acesso exclusivo pelo domínio.

---

## 4. Como funciona o proxy reverso

É uma função serverless na Vercel, em `proxy/api/proxy.js`, para onde todo caminho é
reescrito. Ela acumula quatro responsabilidades:

1. **Roteia por subdomínio.** Lê o cabeçalho `Host`: o que começa com `api.` vai ao
   back-end, o restante vai ao front-end.
2. **Reescreve o destino.** A requisição sai com o `Host` do Cloud Run, sem o qual o
   serviço responderia 404, e sem os cabeçalhos de conexão que corromperiam o roteamento.
3. **Autentica.** Obtém um token de identidade do Google e o anexa. Sem ele os serviços
   recusam com 403.
4. **Distribui e tolera falha.** No caminho do front-end, tenta a região primária e, diante
   de erro de rede ou resposta 5xx, repete na segunda região dentro do mesmo ciclo.

### A cadeia de identidade, sem chaves

Nenhuma credencial de longa duração existe no repositório ou nas variáveis de ambiente. A
identidade é obtida a cada requisição por Workload Identity Federation:

```
1. Vercel entrega um token OIDC curto em x-vercel-oidc-token
2. o token é trocado no STS do Google por credencial federada
3. a credencial gera um token de identidade em nome da proxy-sa
4. esse token acompanha a requisição ao Cloud Run
```

O passo 3 só funciona porque o provedor de identidade no Google Cloud exige que o claim
`sub` do token venha do ambiente de produção deste projeto Vercel específico:

```
assertion.sub.startsWith(
  "owner:soares-projects-ea755c1e:project:200status-proxy:"
)
```

> **Detalhe de menor privilégio.**
> O papel concedido é `roles/iam.serviceAccountOpenIdTokenCreator`, e não
> `serviceAccountTokenCreator`. A diferença importa: o primeiro gera apenas token de
> identidade, usado para provar quem chama; o segundo geraria também token de acesso, que
> abriria as APIs do projeto. Mesmo que a cadeia fosse comprometida, ela não dá acesso a
> nenhum recurso do Google Cloud além de invocar os serviços.

---

## 5. Como funciona a redundância do front-end

O front-end roda em dois serviços Cloud Run independentes, em regiões diferentes:
`southamerica-east1` como primária e `us-central1` como secundária. Ambos servem exatamente
a mesma imagem.

A distribuição é feita pelo proxy, que trata a primária como preferencial e recorre à
secundária apenas em falha. Toda resposta carrega o cabeçalho `X-Origem-Regiao`,
identificando qual região atendeu — é o que torna a comutação observável em vez de suposta.

> **Fragilidade conhecida e assumida.**
> Manter as duas regiões idênticas é hoje um passo manual: cada alteração precisa ser
> implantada nas duas. Durante o trabalho, um deploy feito em apenas uma região deixou as
> versões divergentes, e o failover teria entregue uma interface antiga. Foi detectado
> comparando o *bundle* servido por cada região e corrigido. Em produção real, isso deveria
> ser um pipeline que implanta nas duas regiões numa única operação.

---

## 6. Como a segurança foi implementada

A regra aplicada é a do briefing: bloquear tudo, liberar apenas o necessário. Na prática
isso significou que **nenhum dos três serviços aceita chamada anônima** — todos foram
implantados com `--no-allow-unauthenticated` — e que cada identidade recebe o mínimo
necessário para sua função.

| Identidade | Papel | Alcance |
|---|---|---|
| `backend-sa` | `roles/datastore.user` | Único acesso ao banco em todo o projeto |
| `frontend-sa` | **nenhum papel** | Serve arquivos estáticos e não precisa de acesso a recurso algum |
| `proxy-sa` | `roles/run.invoker` | Concedido serviço a serviço, não no projeto. É o único invocador dos três serviços |

`frontend-sa` e `proxy-sa` **não possuem nenhum papel no nível do projeto**. A permissão do
proxy existe apenas nos três serviços que ele precisa invocar, e a do front-end não existe.

### Camadas de proteção

- **Borda** — TLS gerenciado, única porta de entrada. Porta 80 redireciona para 443.
- **Front e back-end** — sem invocação anônima. Só a identidade do proxy é aceita; mesmo
  quem conhece a URL `.run.app` recebe 403.
- **Aplicação** — CORS restrito a `https://200status.soarespedro.com.br`. Nenhuma outra
  origem web consegue consumir a API.
- **Banco** — sem endpoint de rede. Só `backend-sa` tem permissão, concedida por IAM.

> **Credencial que não vaza adiante.**
> O token OIDC da Vercel chega no cabeçalho `x-vercel-oidc-token` e é consumido pelo proxy
> para gerar o token do Google. Ele entra na lista de cabeçalhos não repassados: se seguisse
> para o destino, o proxy estaria entregando a identidade da Vercel junto com cada
> requisição.

---

## 7. Acessos permitidos e bloqueados

| Origem → destino | Porta | Protocolo | Resultado |
|---|---|---|---|
| Usuário → proxy | 443 | HTTPS / TLS | ✅ permitido |
| Usuário → proxy | 80 | HTTP | ✅ 308 → HTTPS |
| Proxy → front-end, 2 regiões | 443 | HTTPS + token OIDC | ✅ permitido |
| Front-end no navegador → proxy | 443 | HTTPS / TLS | ✅ permitido |
| Proxy → back-end | 443 | HTTPS + token OIDC | ✅ permitido |
| Back-end → Firestore | 443 | HTTPS + IAM | ✅ permitido |
| Internet → back-end `.run.app` | 443 | HTTPS sem token | ❌ 403 |
| Internet → front-end `.run.app` | 443 | HTTPS sem token | ❌ 403 |
| Internet → Firestore | — | — | ❌ sem rota pública |
| Front-end → Firestore | — | — | ❌ sem permissão IAM |
| Origem web fora do domínio → API | 443 | HTTPS | ❌ CORS recusa |

---

## 8. Testes e evidências

Os sete testes exigidos foram executados contra a infraestrutura em produção.

### Testes 1 a 4 — a aplicação funcionando pelo domínio

```
front-end pelo dominio      HTTP 200   regiao: frontend-...-rj (Sao Paulo)
porta 80                    308 -> https://200status.soarespedro.com.br/
bundle servido              main.750afffb.js
URL da API embutida nele    https://api.200status.soarespedro.com.br

GET    /todos               200
POST   /todos               201  {"_id":"dJVohTGX8eZj838y4np4", ...}
DELETE /todos/{id}          200
```

O `POST` seguido de `DELETE` comprova escrita e leitura reais no Firestore, atravessando
toda a cadeia. A URL da API encontrada dentro do *bundle* comprova que o front-end aponta
para o back-end pelo domínio.

### Testes 5 e 6 — os acessos diretos bloqueados

```
back-end     .run.app     403
front-end SP .run.app     403
front-end US .run.app     403
Firestore REST sem credencial   403  Missing or insufficient permissions
```

O bloqueio cobre também o front-end, que é o que garante o acesso exclusivo pelo domínio
configurado, e não pelo endereço fornecido pela nuvem.

### Teste 7 — redundância sob falha real

Uma revisão deliberadamente defeituosa, respondendo `503`, foi implantada em São Paulo e
recebeu 100% do tráfego daquela região, simulando uma região doente em vez de ausente.

```
São Paulo   direto     503
us-central1 direto     200

pelo dominio, 1a vez   200   servido por: frontend-...-uc (us-central1)
pelo dominio, 2a vez   200   servido por: frontend-...-uc
pelo dominio, 3a vez   200   servido por: frontend-...-uc
API durante a queda    200

apos restaurar         200   servido por: frontend-...-rj (Sao Paulo)
```

O usuário não viu erro em momento algum. Após o teste, o tráfego foi devolvido à revisão
saudável e a revisão defeituosa foi removida.

---

## 9. Alterações na aplicação

A aplicação foi mantida; o trabalho concentrou-se na infraestrutura. As mudanças de código
foram as estritamente necessárias para que ela funcionasse na nuvem com segurança.

| Arquivo | Mudança | Motivo |
|---|---|---|
| `backend/index.js` | Camada de dados de Mongoose para Firestore | Banco sem endpoint público; as 4 rotas e o contrato JSON não mudaram |
| `backend/index.js` | Remoção da string de conexão com senha | Havia credencial em código-fonte; a autenticação passou a ser por service account |
| `backend/index.js` | `process.env.PORT` no lugar de 5000 fixo | O Cloud Run injeta a porta |
| `backend/index.js` | CORS restrito a `ALLOWED_ORIGIN` | Estava aberto a qualquer origem |
| `frontend/src/App.js` | URL da API por variável de build | Estava fixa em `localhost:5000`, que quebraria na nuvem e causaria conteúdo misto sob HTTPS |
| `frontend/.env.production` | Arquivo novo com o domínio da API | O deploy por `--source` não aceita `--build-arg` |
| `banco-de-dados/seed-firestore.js` | Substitui `init-mongo.js` | Carga inicial das três tarefas no novo banco |
| `proxy/` | Diretório novo | O proxy reverso, versionado junto com a aplicação |


## 10. Operação e custos

Os três serviços têm escala mínima zero: parados, não geram custo. O consumo fica dentro das
cotas gratuitas — 2 milhões de requisições por mês no Cloud Run, 1 GiB e 50 mil leituras
diárias no Firestore, 500 MB no Artifact Registry, contra os cerca de 79 MB de imagens
armazenadas.

Como rede de proteção, existe um alerta de orçamento de **R$ 1,00** restrito a este projeto,
com disparo já em **1%** — ou seja, no primeiro centavo de gasto.

```bash
# deploy do back-end
gcloud run deploy backend --source ./backend \
  --region southamerica-east1 \
  --service-account backend-sa@mensal2.iam.gserviceaccount.com \
  --no-allow-unauthenticated

# deploy do front-end (repetir nas DUAS regiões)
gcloud run deploy frontend --source ./frontend \
  --region southamerica-east1 \
  --service-account frontend-sa@mensal2.iam.gserviceaccount.com \
  --no-allow-unauthenticated --port 80

# carga inicial do banco
cd banco-de-dados && npm install && node seed-firestore.js
```

---

*Trabalho de Infraestrutura Cloud · aplicação base: `LaercioMLB/aula-uniamerica-infraestrutura-cloud`*
