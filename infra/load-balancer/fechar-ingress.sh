#!/usr/bin/env bash
#
# Fecha a porta de entrada direta dos servicos do Cloud Run.
#
# Com o proxy da Vercel, os tres servicos subiam com --no-allow-unauthenticated
# e recusavam qualquer chamada sem token de identidade: a protecao era de
# IDENTIDADE. O Load Balancer nao envia token de identidade - serverless NEGs
# nao tem como faze-lo - entao os servicos precisaram aceitar chamada anonima.
#
# O que passa a proteger e a REDE: com ingress=internal-and-cloud-load-balancing
# a URL .run.app recusa tudo o que vem da Internet, e so o balanceador atravessa.
# O efeito para quem esta de fora e o mesmo (nao alcanca o servico direto), mas o
# mecanismo e outro, e isso precisa estar claro no diagrama.
#
# Rode DEPOIS de confirmar que o dominio responde pelo LB. Fechar antes deixa a
# aplicacao inalcancavel pelos dois caminhos ao mesmo tempo.

set -u

PROJETO="${PROJETO:-mensal2}"
INGRESS="${1:-internal-and-cloud-load-balancing}"

echo "== Ajustando ingress dos servicos para: $INGRESS =="
echo

ajustar() {
  local servico="$1" regiao="$2"
  printf '  %-10s %-20s ... ' "$servico" "$regiao"
  if gcloud run services update "$servico" --region="$regiao" --ingress="$INGRESS" \
       --quiet --project="$PROJETO" >/dev/null 2>&1; then
    echo "ok"
  else
    echo "FALHOU"
  fi
}

ajustar backend  southamerica-east1
ajustar frontend southamerica-east1
ajustar frontend us-central1

echo
echo "-- estado atual --"
for par in "backend southamerica-east1" "frontend southamerica-east1" "frontend us-central1"; do
  set -- $par
  valor=$(gcloud run services describe "$1" --region="$2" --project="$PROJETO" \
    --format="value(metadata.annotations['run.googleapis.com/ingress'])" 2>/dev/null)
  printf '  %-10s %-20s ingress=%s\n' "$1" "$2" "${valor:-all}"
done

echo
echo "-- prova do bloqueio: acesso direto pela URL .run.app --"
# Esta e a evidencia do requisito "back-end nao exposto diretamente a Internet".
# Esperado: falha de conexao ou 403/404, nunca 200.
for url in \
  "https://backend-lnjz6zmyda-rj.a.run.app/todos" \
  "https://frontend-lnjz6zmyda-rj.a.run.app/" \
  "https://frontend-lnjz6zmyda-uc.a.run.app/"; do
  printf '  %-52s -> ' "${url#https://}"
  curl -s -o /dev/null -w '%{http_code}\n' --max-time 15 "$url" 2>/dev/null || echo "sem resposta"
done

echo
echo "Para reverter (por exemplo, antes de remover o LB com teardown.sh):"
echo "  bash $0 all"
