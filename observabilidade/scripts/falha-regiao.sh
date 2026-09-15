#!/usr/bin/env bash
#
# Cenario 3 - falha controlada de uma regiao do front-end.
#
# Implanta em southamerica-east1 uma revisao deliberadamente defeituosa, que
# responde 503 a tudo, e envia 100% do trafego daquela regiao para ela. Isso
# simula uma regiao doente (respondendo errado) e nao apenas ausente, que e o
# caso mais dificil para o proxy: a conexao e aceita, e so a resposta revela o
# problema.
#
# O proxy deve entao recorrer a us-central1 dentro do mesmo ciclo, sem que o
# usuario veja erro. O cabecalho X-Origem-Regiao e o painel 6 comprovam o
# deslocamento.
#
# ATENCAO: altera o roteamento de trafego do front-end em producao. Restaura ao
# final, inclusive se interrompido.
#
# Painel validado: 6 (redundancia), com a serie failover=true saindo de zero.

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
gcloud run deploy "$SERVICO" --source "$TEMP" --region="$REGIAO" --project="$PROJETO" \
  --service-account="frontend-sa@${PROJETO}.iam.gserviceaccount.com" \
  --no-allow-unauthenticated --port 80 --tag=doente --no-traffic --quiet

DOENTE=$(gcloud run services describe "$SERVICO" --region="$REGIAO" --project="$PROJETO" \
  --format='value(status.latestCreatedRevisionName)')

echo
echo "-- enviando 100% do trafego de $REGIAO para $DOENTE --"
gcloud run services update-traffic "$SERVICO" --region="$REGIAO" --project="$PROJETO" \
  --to-revisions="$DOENTE=100" --quiet >/dev/null

sleep 15

echo
echo "-- durante a falha: o usuario ve erro? --"
for i in $(seq 1 8); do
  status=$(curl -s -o /dev/null -w '%{http_code}' "$FRONT/")
  regiao=$(curl -s -D - -o /dev/null "$FRONT/" | sed -n 's/^[Xx]-[Oo]rigem-[Rr]egiao: //p' | tr -d '\r')
  printf 'req %d: HTTP %s  atendida por: %s\n' "$i" "$status" "$regiao"
done

echo
echo "-- a API continua disponivel durante a queda do front-end? --"
curl -s -o /dev/null -w 'GET /todos -> %{http_code}\n' \
  "https://api.200status.soarespedro.com.br/todos"

echo
echo "fim da janela de falha: $(agora)"
echo "Esperado: HTTP 200 em todas as requisicoes, atendidas por us-central1,"
echo "e a serie failover=true saindo de zero no painel 6."

rm -rf "$TEMP"
