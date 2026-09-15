#!/usr/bin/env bash
#
# Cenario 1 - uso normal da aplicacao pelo dominio configurado.
#
# Exercita a cadeia completa (dominio -> proxy -> back-end -> Firestore) com as
# quatro operacoes de negocio, e inclui de proposito dois erros de cliente para
# que o painel de Erros tenha o que mostrar sem precisar quebrar nada:
#
#   POST /todos sem o campo "text"      -> 400
#   PATCH /todos/{id inexistente}       -> 404
#
# Todas as chamadas vao ao dominio. Nenhuma toca a URL .run.app, que responde
# 403 por construcao.
#
# Uso:  ./carga.sh [repeticoes]        (padrao: 12)

set -u

API="https://api.200status.soarespedro.com.br"
FRONT="https://200status.soarespedro.com.br"
REPETICOES="${1:-12}"

# Fuso de Sao Paulo, na forma POSIX literal: o Git Bash no Windows nao traz a
# base de fusos, e "America/Sao_Paulo" sairia silenciosamente como GMT. O
# dashboard usa o mesmo fuso, para que a janela selecionada no painel
# corresponda ao horario anotado na evidencia.
export TZ='<-03>3'

# Toda evidencia carimba os dois fusos: o local, que e o do dashboard, e o UTC,
# que e o do timestamp gravado pelo Cloud Logging.
agora() { printf '%s (%s UTC)' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$(date -u '+%H:%M:%S')"; }

echo "== Carga controlada =="
echo "inicio: $(agora)"
echo "repeticoes: $REPETICOES"
echo

codigo() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

for i in $(seq 1 "$REPETICOES"); do
  # 1. front-end pelo dominio
  cf=$(codigo "$FRONT/")

  # 2. listar tarefas
  cl=$(codigo "$API/todos")

  # 3. criar tarefa (percorre back-end e banco, com escrita real)
  resposta=$(curl -s -X POST "$API/todos" \
    -H 'Content-Type: application/json' \
    -d "{\"text\":\"carga de teste $i\"}")
  id=$(printf '%s' "$resposta" | sed -n 's/.*"_id":"\([^"]*\)".*/\1/p')

  # 4. concluir e excluir a tarefa recem-criada
  if [ -n "$id" ]; then
    cp=$(codigo -X PATCH "$API/todos/$id")
    cd_=$(codigo -X DELETE "$API/todos/$id")
  else
    cp="--"; cd_="--"
  fi

  # 5. erros de cliente previstos pela propria aplicacao
  c400=$(codigo -X POST "$API/todos" -H 'Content-Type: application/json' -d '{}')
  c404=$(codigo -X PATCH "$API/todos/id-que-nao-existe")

  printf '%2d/%s  front:%s listar:%s criar:%s concluir:%s excluir:%s | 400:%s 404:%s\n' \
    "$i" "$REPETICOES" "$cf" "$cl" "${id:+201}" "$cp" "$cd_" "$c400" "$c404"
done

echo
echo "fim: $(agora)"
echo
echo "Os registros levam ate ~2 min para aparecer nos paineis."
echo "Paineis validados por este cenario: 2 (desempenho), 3 (erros),"
echo "4 (uso) e 5 (banco de dados)."
