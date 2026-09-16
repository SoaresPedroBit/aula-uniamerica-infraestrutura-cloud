#!/usr/bin/env bash
#
# Desmonta o Load Balancer, na ordem inversa da criacao.
#
# ATENCAO: depois disto a aplicacao fica SEM ENTRADA. Os dominios continuam
# apontando para um IP que deixou de existir, e o site sai do ar ate que:
#   - o LB seja recriado com criar.sh (o IP sera outro, e o DNS precisa mudar), ou
#   - o DNS volte a apontar para o proxy da Vercel.
#
# Existe porque o LB custa ~US$ 18/mes mesmo parado, e este projeto rodava a
# custo zero antes dele. Rode depois da apresentacao.
#
# A ordem importa: o Google Cloud recusa apagar um recurso que ainda esta em
# uso por outro. Regras de encaminhamento primeiro, IP por ultimo.

set -u

PROJETO="${PROJETO:-mensal2}"

echo "== Desmontando o Load Balancer do projeto $PROJETO =="
echo
echo "A aplicacao ficara SEM ENTRADA ao fim deste script."
echo "Os dominios 200status e api.200status deixarao de responder."
echo
printf 'Digite "desmontar" para confirmar: '
read -r resposta
if [ "$resposta" != "desmontar" ]; then
  echo "Cancelado. Nada foi removido."
  exit 0
fi

remover() {
  local descricao="$1"; shift
  if gcloud "$@" --project="$PROJETO" --quiet >/dev/null 2>&1; then
    echo "  removido:    $descricao"
  else
    echo "  ja ausente:  $descricao"
  fi
}

echo
echo "-- regras de encaminhamento (param a cobranca por hora) --"
remover "fr-https-200status" compute forwarding-rules delete fr-https-200status --global
remover "fr-http-200status"  compute forwarding-rules delete fr-http-200status  --global

echo
echo "-- proxies --"
remover "proxy-https-200status" compute target-https-proxies delete proxy-https-200status --global
remover "proxy-http-200status"  compute target-http-proxies  delete proxy-http-200status  --global

echo
echo "-- certificado --"
remover "cert-200status" compute ssl-certificates delete cert-200status --global

echo
echo "-- url maps --"
remover "urlmap-200status"          compute url-maps delete urlmap-200status          --global
remover "urlmap-redirect-200status" compute url-maps delete urlmap-redirect-200status --global

echo
echo "-- backend services --"
remover "bs-frontend" compute backend-services delete bs-frontend --global
remover "bs-backend"  compute backend-services delete bs-backend  --global

echo
echo "-- serverless NEGs --"
remover "neg-frontend-rj" compute network-endpoint-groups delete neg-frontend-rj --region=southamerica-east1
remover "neg-frontend-uc" compute network-endpoint-groups delete neg-frontend-uc --region=us-central1
remover "neg-backend-rj"  compute network-endpoint-groups delete neg-backend-rj  --region=southamerica-east1

echo
echo "-- IP estatico --"
remover "ip-200status" compute addresses delete ip-200status --global

echo
echo "== Desmontado =="
echo
echo "Os servicos do Cloud Run continuam no ar, mas com"
echo "ingress=internal-and-cloud-load-balancing eles agora nao aceitam"
echo "ninguem: o unico caminho permitido era o LB que acabou de ser removido."
echo
echo "Para deixa-los acessiveis de novo pela URL .run.app:"
echo "  gcloud run services update <servico> --region=<regiao> --ingress=all"
