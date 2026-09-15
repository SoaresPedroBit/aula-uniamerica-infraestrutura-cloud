#!/usr/bin/env bash
#
# Cenario 2 - falha controlada no acesso ao banco de dados.
#
# Remove temporariamente roles/datastore.user da backend-sa. O back-end
# continua no ar e respondendo, mas toda operacao no Firestore passa a ser
# recusada com PERMISSION_DENIED (codigo gRPC 7), que o back-end converte em
# HTTP 500.
#
# Por que esta falha e nao outra: ela nao toca no codigo, e reversivel com um
# unico comando, e produz exatamente o sintoma que o painel de Banco de dados
# existe para detectar. Uma falha simulada dentro da aplicacao provaria apenas
# que o codigo sabe registrar um erro que ele mesmo inventou.
#
# ATENCAO: altera o IAM do projeto em producao. Restaura ao final, inclusive se
# interrompido.
#
# Paineis validados: 3 (erros, com 5xx reais) e 5 (banco, com result=error).

set -u

PROJETO="mensal2"
CONTA="backend-sa@${PROJETO}.iam.gserviceaccount.com"
PAPEL="roles/datastore.user"
API="https://api.200status.soarespedro.com.br"
# Fuso de Sao Paulo, na forma POSIX literal: o Git Bash no Windows nao traz a
# base de fusos, e "America/Sao_Paulo" sairia silenciosamente como GMT. O
# dashboard usa o mesmo fuso, para que a janela selecionada no painel
# corresponda ao horario anotado na evidencia.
export TZ='<-03>3'

# Toda evidencia carimba os dois fusos: o local, que e o do dashboard, e o UTC,
# que e o do timestamp gravado pelo Cloud Logging.
agora() { printf '%s (%s UTC)' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$(date -u '+%H:%M:%S')"; }

restaurar() {
  echo
  echo "-- restaurando $PAPEL para $CONTA --"
  gcloud projects add-iam-policy-binding "$PROJETO" \
    --member="serviceAccount:$CONTA" --role="$PAPEL" \
    --condition=None --format='value(etag)' >/dev/null 2>&1
  echo "restaurado em $(agora); aguardando propagacao..."

  # A propagacao do IAM nao e instantanea, e as instancias ja em execucao
  # mantem a credencial anterior em cache: medido em ~2 min. Esperar um tempo
  # fixo daria "restaurado" com a producao ainda falhando, entao a confirmacao
  # e por resultado, e nao por relogio.
  for tentativa in $(seq 1 12); do
    sleep 20
    codigo=$(curl -s -o /dev/null -w '%{http_code}' "$API/todos")
    printf '  verificacao %2d: GET /todos -> %s\n' "$tentativa" "$codigo"
    if [ "$codigo" = "200" ]; then
      # Duas respostas boas seguidas: uma so poderia ser uma instancia que
      # ainda nao havia sido afetada pela remocao.
      sleep 10
      if [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/todos")" = "200" ]; then
        echo "  acesso ao banco restabelecido em $(agora)"
        return 0
      fi
    fi
  done

  echo "  ATENCAO: o acesso ao banco nao voltou em 4 min. Verifique com:"
  echo "    gcloud projects get-iam-policy $PROJETO \\"
  echo "      --flatten='bindings[].members' --filter='bindings.members:$CONTA'"
  return 1
}

# Restaura mesmo se o script for interrompido: deixar a producao sem acesso ao
# banco por engano seria pior que nao ter feito o teste.
trap restaurar EXIT

echo "== Falha controlada: acesso ao banco =="
echo "inicio: $(agora)"
echo

echo -n "estado inicial: GET /todos -> "
curl -s -o /dev/null -w '%{http_code}\n' "$API/todos"

echo
echo "-- removendo $PAPEL de $CONTA --"
gcloud projects remove-iam-policy-binding "$PROJETO" \
  --member="serviceAccount:$CONTA" --role="$PAPEL" \
  --condition=None --format='value(etag)' >/dev/null

echo "removido em $(agora); aguardando propagacao..."
sleep 60

echo
echo "-- requisicoes durante a falha --"
for i in $(seq 1 8); do
  printf 'tentativa %d: GET /todos -> %s\n' "$i" \
    "$(curl -s -o /dev/null -w '%{http_code}' "$API/todos")"
  printf 'tentativa %d: POST /todos -> %s\n' "$i" \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/todos" \
       -H 'Content-Type: application/json' -d "{\"text\":\"durante a falha $i\"}")"
done

echo
echo "fim da janela de falha: $(agora)"
echo "Esperado: 500 nas requisicoes, e db_operation com result=error e"
echo "error_type=7 (PERMISSION_DENIED) no painel 5."
