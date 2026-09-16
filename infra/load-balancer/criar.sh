#!/usr/bin/env bash
#
# Monta o Application Load Balancer externo global que substituiu o proxy
# reverso serverless da Vercel.
#
#   Usuario --> IP global --> forwarding rule 443 --> target-https-proxy
#                                 |                        |
#                                 |                     url map (roteia por Host)
#                                 |                     /                  \
#                                 |            bs-frontend               bs-backend
#                                 |            /         \                    |
#                                 |     neg-frontend-rj  neg-frontend-uc  neg-backend-rj
#                                 |      (Sao Paulo)      (Iowa)           (Sao Paulo)
#                                 |
#                          forwarding rule 80 --> url map de redirecionamento --> 301
#
# O roteamento por cabecalho Host, que antes era codigo no handler do proxy,
# passa a ser declaracao no url map. O failover entre regioes, que era um laco
# try/catch, passa a ser outlierDetection no backend service.
#
# CUSTO: a partir daqui o projeto deixa de ser gratuito. As regras de
# encaminhamento custam ~US$ 0,025/hora (~US$ 18/mes) mesmo sem trafego algum,
# mais o processamento de dados. Rode o teardown.sh depois da apresentacao.

set -u

PROJETO="${PROJETO:-mensal2}"
RAIZ="$(cd "$(dirname "$0")" && pwd)"

DOMINIO_FRONT="200status.soarespedro.com.br"
DOMINIO_API="api.200status.soarespedro.com.br"
REGIAO_PRIMARIA="southamerica-east1"
REGIAO_SECUNDARIA="us-central1"

echo "== Montando o Load Balancer no projeto $PROJETO =="
echo

# Cada passo verifica antes de criar: o script pode ser reexecutado apos uma
# falha no meio sem duplicar recurso nem abortar no primeiro que ja existe.
existe() { gcloud "$@" --project="$PROJETO" >/dev/null 2>&1; }

# ---- 1. IP estatico global -------------------------------------------------
# Precisa ser estatico porque e ele que vai no registro A do DNS: um IP efemero
# mudaria a cada recriacao e derrubaria o dominio.
echo "-- IP estatico global --"
if existe compute addresses describe ip-200status --global; then
  echo "  ja existe: ip-200status"
else
  gcloud compute addresses create ip-200status --global --project="$PROJETO" >/dev/null \
    && echo "  criado: ip-200status"
fi
IP=$(gcloud compute addresses describe ip-200status --global --project="$PROJETO" --format='value(address)')
echo "  endereco: $IP"

# ---- 2. Serverless NEGs ----------------------------------------------------
# Um NEG por servico e por regiao. Nao tem endereco nem porta: e um ponteiro
# para o servico do Cloud Run daquela regiao.
echo
echo "-- serverless NEGs --"
criar_neg() {
  local nome="$1" regiao="$2" servico="$3"
  if existe compute network-endpoint-groups describe "$nome" --region="$regiao"; then
    echo "  ja existe: $nome"
  else
    gcloud compute network-endpoint-groups create "$nome" --region="$regiao" \
      --network-endpoint-type=serverless --cloud-run-service="$servico" \
      --project="$PROJETO" >/dev/null && echo "  criado:    $nome ($regiao -> $servico)"
  fi
}
criar_neg neg-frontend-rj "$REGIAO_PRIMARIA"   frontend
criar_neg neg-frontend-uc "$REGIAO_SECUNDARIA" frontend
criar_neg neg-backend-rj  "$REGIAO_PRIMARIA"   backend

# ---- 3. Backend services ---------------------------------------------------
# Criados vazios e depois importados do YAML, que carrega o outlierDetection.
# Nao passe --protocol: com serverless NEG o campo portName resultante e
# recusado com "Port name is not supported for a backend service with
# Serverless network endpoint groups".
echo
echo "-- backend services --"
for bs in bs-frontend bs-backend; do
  if existe compute backend-services describe "$bs" --global; then
    echo "  ja existe: $bs"
  else
    gcloud compute backend-services create "$bs" --global \
      --load-balancing-scheme=EXTERNAL_MANAGED \
      --enable-logging --logging-sample-rate=1.0 \
      --project="$PROJETO" >/dev/null && echo "  criado:    $bs"
  fi
done

anexar() {
  local bs="$1" neg="$2" regiao="$3"
  if gcloud compute backend-services describe "$bs" --global --project="$PROJETO" \
       --format='value(backends[].group)' | grep -q "$neg"; then
    echo "  ja anexado: $neg -> $bs"
  else
    gcloud compute backend-services add-backend "$bs" --global \
      --network-endpoint-group="$neg" --network-endpoint-group-region="$regiao" \
      --project="$PROJETO" >/dev/null 2>&1 && echo "  anexado:    $neg -> $bs"
  fi
}
anexar bs-frontend neg-frontend-rj "$REGIAO_PRIMARIA"
anexar bs-frontend neg-frontend-uc "$REGIAO_SECUNDARIA"
anexar bs-backend  neg-backend-rj  "$REGIAO_PRIMARIA"

# outlierDetection so entra por import: nao ha flag confiavel para ele. E o
# unico mecanismo de failover disponivel aqui, porque health check nao existe
# para backend serverless. Sem isto o balanceador continua mandando trafego
# para uma regiao que esta respondendo erro.
echo
echo "-- outlierDetection (failover entre regioes) --"
gcloud compute backend-services import bs-frontend --global \
  --source="$RAIZ/backend-service-frontend.yaml" --quiet --project="$PROJETO" >/dev/null 2>&1 \
  && echo "  aplicado em bs-frontend"

# ---- 4. URL map: o roteamento por Host -------------------------------------
echo
echo "-- url map --"
if existe compute url-maps describe urlmap-200status --global; then
  echo "  ja existe: urlmap-200status"
else
  gcloud compute url-maps create urlmap-200status --default-service=bs-frontend \
    --global --project="$PROJETO" >/dev/null
  gcloud compute url-maps add-path-matcher urlmap-200status \
    --path-matcher-name=matcher-api --default-service=bs-backend \
    --new-hosts="$DOMINIO_API" --global --project="$PROJETO" >/dev/null
  gcloud compute url-maps add-path-matcher urlmap-200status \
    --path-matcher-name=matcher-front --default-service=bs-frontend \
    --new-hosts="$DOMINIO_FRONT" --global --project="$PROJETO" >/dev/null
  echo "  criado:    urlmap-200status ($DOMINIO_API -> bs-backend, $DOMINIO_FRONT -> bs-frontend)"
fi

# ---- 5. TLS e entrada ------------------------------------------------------
# O certificado gerenciado so sai de PROVISIONING depois que o DNS dos dois
# dominios apontar para o IP acima. Ate la, o LB nao serve HTTPS.
echo
echo "-- certificado e entrada HTTPS --"
if existe compute ssl-certificates describe cert-200status --global; then
  echo "  ja existe: cert-200status"
else
  gcloud compute ssl-certificates create cert-200status \
    --domains="$DOMINIO_FRONT,$DOMINIO_API" --global --project="$PROJETO" >/dev/null \
    && echo "  criado:    cert-200status"
fi

if existe compute target-https-proxies describe proxy-https-200status --global; then
  echo "  ja existe: proxy-https-200status"
else
  gcloud compute target-https-proxies create proxy-https-200status \
    --url-map=urlmap-200status --ssl-certificates=cert-200status \
    --global --project="$PROJETO" >/dev/null && echo "  criado:    proxy-https-200status"
fi

if existe compute forwarding-rules describe fr-https-200status --global; then
  echo "  ja existe: fr-https-200status"
else
  gcloud compute forwarding-rules create fr-https-200status --address=ip-200status \
    --global --target-https-proxy=proxy-https-200status --ports=443 \
    --load-balancing-scheme=EXTERNAL_MANAGED --project="$PROJETO" >/dev/null \
    && echo "  criada:    fr-https-200status (porta 443)"
fi

# ---- 6. Redirecionamento 80 -> 443 -----------------------------------------
# Um url map separado, que nao roteia para backend algum: so devolve 301.
echo
echo "-- redirecionamento da porta 80 --"
if existe compute url-maps describe urlmap-redirect-200status --global; then
  echo "  ja existe: urlmap-redirect-200status"
else
  gcloud compute url-maps import urlmap-redirect-200status \
    --source="$RAIZ/urlmap-redirect.yaml" --global --quiet --project="$PROJETO" >/dev/null \
    && echo "  criado:    urlmap-redirect-200status"
fi

if existe compute target-http-proxies describe proxy-http-200status --global; then
  echo "  ja existe: proxy-http-200status"
else
  gcloud compute target-http-proxies create proxy-http-200status \
    --url-map=urlmap-redirect-200status --global --project="$PROJETO" >/dev/null \
    && echo "  criado:    proxy-http-200status"
fi

if existe compute forwarding-rules describe fr-http-200status --global; then
  echo "  ja existe: fr-http-200status"
else
  gcloud compute forwarding-rules create fr-http-200status --address=ip-200status \
    --global --target-http-proxy=proxy-http-200status --ports=80 \
    --load-balancing-scheme=EXTERNAL_MANAGED --project="$PROJETO" >/dev/null \
    && echo "  criada:    fr-http-200status (porta 80)"
fi

echo
echo "== Pronto =="
echo
echo "Aponte os dois dominios para $IP com registros A:"
echo "  A  200status      $IP"
echo "  A  api.200status  $IP"
echo
echo "O certificado so provisiona depois disso. Acompanhe com:"
echo "  gcloud compute ssl-certificates describe cert-200status --global \\"
echo "    --format='value(managed.status,managed.domainStatus)'"
echo
echo "Os servicos do Cloud Run precisam de --allow-unauthenticated (o LB nao"
echo "envia token de identidade) e, depois de validado, de"
echo "--ingress=internal-and-cloud-load-balancing para recusar acesso direto."
