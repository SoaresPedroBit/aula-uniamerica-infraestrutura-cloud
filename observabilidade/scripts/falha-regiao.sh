#!/usr/bin/env bash
#
# Cenario 3 - falha controlada de uma regiao do front-end.
#
# Implanta em southamerica-east1 uma revisao deliberadamente defeituosa, que
# responde 503 a tudo, e envia 100% do trafego daquela regiao para ela. Isso
# simula uma regiao doente (respondendo errado) e nao apenas ausente, que e o
# caso mais dificil de detectar: a conexao e aceita, e so a resposta revela o
# problema.
#
# O QUE MUDOU COM O LOAD BALANCER
#
# Na versao anterior o failover era codigo: o proxy na Vercel via o 503 e
# reencaminhava para a segunda regiao dentro do mesmo ciclo, de modo que o
# usuario nunca via erro. O balanceador da GCP nao faz isso.
#
# Health check nao existe para backend serverless - o Cloud Run nao expoe
# instancias a sondar - e sem configuracao o balanceador continua mandando
# trafego para uma regiao que responde erro. Quem resolve e o outlierDetection
# do backend service bs-frontend: apos 3 respostas 5xx consecutivas, ele ejeta
# a regiao por 30 segundos.
#
# A consequencia pratica e que este teste passou a ter duas fases: os primeiros
# erros CHEGAM ao usuario, e so depois o trafego se desloca. O script observa as
# duas, porque essa e a diferenca honesta entre as duas arquiteturas.
#
# ATENCAO: altera o roteamento de trafego do front-end em producao. Restaura ao
# final, inclusive se interrompido.
#
# Painel validado: 6 (redundancia), pela metrica nativa do balanceador, em que o
# rotulo backend_scope deixa de mostrar southamerica-east1 e passa a us-central1.

set -u

PROJETO="mensal2"
SERVICO="frontend"
REGIAO="southamerica-east1"
FRONT="https://200status.soarespedro.com.br"
# Fuso de Sao Paulo, na forma POSIX literal: o Git Bash no Windows nao traz a
# base de fusos, e "America/Sao_Paulo" sairia silenciosamente como GMT. O
# dashboard usa o mesmo fuso, para que a janela selecionada no painel
# corresponda ao horario anotado na evidencia.
export TZ='<-03>3'

# Toda evidencia carimba os dois fusos: o local, que e o do dashboard, e o UTC,
# que e o do timestamp gravado pelo Cloud Logging.
agora() { printf '%s (%s UTC)' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$(date -u '+%H:%M:%S')"; }

# Revisao saudavel que esta atendendo agora, para onde o trafego volta ao fim.
SAUDAVEL=$(gcloud run services describe "$SERVICO" --region="$REGIAO" \
  --project="$PROJETO" --format='value(status.traffic[0].revisionName)')

restaurar() {
  echo
  echo "-- devolvendo 100% do trafego a revisao saudavel ($SAUDAVEL) --"
  gcloud run services update-traffic "$SERVICO" --region="$REGIAO" \
    --project="$PROJETO" --to-revisions="$SAUDAVEL=100" --quiet >/dev/null 2>&1
  echo "restaurado em $(agora)"
  echo -n "verificacao final pelo dominio: "
  curl -s -o /dev/null -w '%{http_code}' "$FRONT/"
  echo -n "  regiao: "
  curl -s -D - -o /dev/null "$FRONT/" | sed -n 's/^[Xx]-[Oo]rigem-[Rr]egiao: //p'
  echo
  echo "Remova a revisao defeituosa quando nao precisar mais dela:"
  echo "  gcloud run revisions delete <revisao-503> --region=$REGIAO"
}

trap restaurar EXIT

echo "== Falha controlada: regiao do front-end =="
echo "inicio: $(agora)"
echo "revisao saudavel atual: $SAUDAVEL"
echo

echo "-- estado inicial: qual regiao atende --"
curl -s -D - -o /dev/null "$FRONT/" | sed -n 's/^[Xx]-[Oo]rigem-[Rr]egiao: /regiao: /p'

# Uma imagem minima que responde 503 a qualquer caminho. Nao serve a aplicacao:
# o objetivo e justamente que esta regiao pare de servi-la corretamente.
TEMP=$(mktemp -d)
cat > "$TEMP/Dockerfile" <<'DOCKER'
FROM nginx:alpine
RUN printf 'server {\n listen 80;\n location / {\n  return 503 "regiao indisponivel (teste controlado)";\n }\n}\n' \
    > /etc/nginx/conf.d/default.conf
DOCKER

echo
echo "-- implantando revisao defeituosa em $REGIAO --"
# --allow-unauthenticated agora, e nao mais o contrario: serverless NEGs nao
# enviam token de identidade, entao a revisao de teste precisa aceitar a chamada
# do balanceador como qualquer outra. Se subir privada, o 503 que queremos medir
# viraria um 403 de autenticacao, e o teste mediria a coisa errada.
gcloud run deploy "$SERVICO" --source "$TEMP" --region="$REGIAO" --project="$PROJETO" \
  --service-account="frontend-sa@${PROJETO}.iam.gserviceaccount.com" \
  --allow-unauthenticated --port 80 --tag=doente --no-traffic --quiet

DOENTE=$(gcloud run services describe "$SERVICO" --region="$REGIAO" --project="$PROJETO" \
  --format='value(status.latestCreatedRevisionName)')

echo
echo "-- enviando 100% do trafego de $REGIAO para $DOENTE --"
gcloud run services update-traffic "$SERVICO" --region="$REGIAO" --project="$PROJETO" \
  --to-revisions="$DOENTE=100" --quiet >/dev/null

sleep 15

echo
echo "-- durante a falha: quando o balanceador ejeta a regiao doente? --"
echo "   (esperado: alguns 503 de southamerica-east1 e, apos 3 seguidos,"
echo "    a ejecao e a virada para us-central1)"
echo

erros_ate_ejetar=0
ejetou=nao

# Uma unica requisicao por iteracao, lendo status e regiao do mesmo cabecalho:
# duas chamadas separadas contariam erros em dobro para o outlierDetection e
# falseariam o momento da ejecao.
for i in $(seq 1 25); do
  resposta=$(curl -s -D - -o /dev/null --max-time 20 "$FRONT/" 2>/dev/null)
  status=$(printf '%s' "$resposta" | sed -n 's|^HTTP/[0-9.]* \([0-9]*\).*|\1|p' | tail -1)
  regiao=$(printf '%s' "$resposta" | sed -n 's/^[Xx]-[Oo]rigem-[Rr]egiao: //p' | tr -d '\r')

  printf 'req %2d: HTTP %-3s  atendida por: %s\n' "$i" "${status:-???}" "${regiao:-(sem cabecalho)}"

  if [ "$ejetou" = "nao" ]; then
    if [ "$regiao" = "us-central1" ]; then
      ejetou=sim
      echo
      echo "   >>> ejecao detectada na requisicao $i, apos $erros_ate_ejetar erro(s)"
      echo
    elif [ "${status:-0}" -ge 500 ] 2>/dev/null; then
      erros_ate_ejetar=$((erros_ate_ejetar + 1))
    fi
  fi
  sleep 2
done

echo
if [ "$ejetou" = "sim" ]; then
  echo "RESULTADO: o outlierDetection ejetou a regiao doente."
  echo "Custo da deteccao passiva: $erros_ate_ejetar requisicao(oes) receberam erro antes."
else
  echo "RESULTADO: a ejecao NAO ocorreu dentro da janela observada."
  echo "Revise consecutiveErrors e interval em"
  echo "  infra/load-balancer/backend-service-frontend.yaml"
  echo "ou registre a limitacao na documentacao - nao a omita."
fi

echo
echo "-- a API continua disponivel durante a queda do front-end? --"
curl -s -o /dev/null -w 'GET /todos -> %{http_code}\n' \
  "https://api.200status.soarespedro.com.br/todos"

echo
echo "fim da janela de falha: $(agora)"
echo "Esperado: os primeiros 503 vindos de southamerica-east1, a ejecao apos 3"
echo "erros seguidos, e o restante das requisicoes atendido por us-central1."
echo "No painel 6, o rotulo backend_scope migra de uma regiao para a outra."

rm -rf "$TEMP"
