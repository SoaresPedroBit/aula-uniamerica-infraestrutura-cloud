#!/usr/bin/env bash
#
# Cria no projeto tudo o que sustenta os paineis: as quatro log-based metrics,
# os dois uptime checks e o dashboard.
#
# E idempotente por omissao, nao por sobrescrita: o que ja existe e apenas
# reportado, para que uma reexecucao distraida nao apague um painel ajustado a
# mao. Para atualizar uma definicao, apague o recurso e rode de novo.
#
# Pre-requisito: gcloud autenticado, com permissao de edicao no projeto.

set -u

PROJETO="${PROJETO:-mensal2}"
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"

echo "== Provisionando observabilidade no projeto $PROJETO =="
echo

# ---- 1. Log-based metrics -------------------------------------------------
# Contam apenas registros gravados APOS a criacao. Precisam existir antes de
# qualquer carga de teste, senao os paineis nascem vazios.
echo "-- log-based metrics --"
existentes=$(gcloud logging metrics list --project="$PROJETO" --format='value(name)')

for arquivo in "$RAIZ"/metrics/*.yaml; do
  nome=$(basename "$arquivo" .yaml)
  if printf '%s\n' "$existentes" | grep -qx "$nome"; then
    echo "  ja existe: $nome"
  else
    gcloud logging metrics create "$nome" --config-from-file="$arquivo" \
      --project="$PROJETO" >/dev/null && echo "  criada:    $nome"
  fi
done

# ---- 2. Uptime checks -----------------------------------------------------
# Criados pela API REST, e nao por flags do gcloud, para que o arquivo JSON
# versionado seja a unica fonte da verdade da configuracao.
echo
echo "-- uptime checks --"
TOKEN=$(gcloud auth print-access-token)
checks=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "https://monitoring.googleapis.com/v3/projects/$PROJETO/uptimeCheckConfigs")

for arquivo in "$RAIZ"/uptime/*.json; do
  nome=$(basename "$arquivo" .json)
  if printf '%s' "$checks" | grep -q "\"displayName\": \"$nome\""; then
    echo "  ja existe: $nome"
  else
    resposta=$(curl -s -X POST \
      "https://monitoring.googleapis.com/v3/projects/$PROJETO/uptimeCheckConfigs" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d @"$arquivo")
    if printf '%s' "$resposta" | grep -q '"error"'; then
      echo "  FALHOU:    $nome"
      printf '%s\n' "$resposta" | head -5
    else
      echo "  criado:    $nome"
    fi
  fi
done

# ---- 3. Dashboard ---------------------------------------------------------
echo
echo "-- dashboard --"
if gcloud monitoring dashboards list --project="$PROJETO" \
     --format='value(displayName)' | grep -q '200status - Observabilidade'; then
  echo "  ja existe: 200status - Observabilidade"
  echo "  (para atualizar: gcloud monitoring dashboards delete <id>, e rode de novo)"
else
  gcloud monitoring dashboards create \
    --config-from-file="$RAIZ/dashboards/200status-observabilidade.json" \
    --project="$PROJETO" && echo "  criado:    200status - Observabilidade"
fi

# ---- 4. Permissao do proxy ------------------------------------------------
# O proxy roda na Vercel e escreve no Cloud Logging com o token federado, que
# representa o PRINCIPAL do Workload Identity Pool - nao a proxy-sa. Conceder
# o papel a service account nao funciona: a escrita e feita antes da
# impersonacao, e recebe 403.
echo
echo "-- permissao de escrita do proxy --"
PRINCIPAL="principal://iam.googleapis.com/projects/1076166965572/locations/global/workloadIdentityPools/vercel/subject/owner:soares-projects-ea755c1e:project:200status-proxy:environment:production"
if gcloud projects get-iam-policy "$PROJETO" --flatten='bindings[].members' \
     --filter="bindings.members:\"$PRINCIPAL\" AND bindings.role=roles/logging.logWriter" \
     --format='value(bindings.role)' | grep -q logWriter; then
  echo "  ja concedida: roles/logging.logWriter ao principal federado"
else
  gcloud projects add-iam-policy-binding "$PROJETO" --member="$PRINCIPAL" \
    --role='roles/logging.logWriter' --condition=None --format='value(etag)' >/dev/null \
    && echo "  concedida:    roles/logging.logWriter ao principal federado"
fi

echo
echo "Pronto. Abra o dashboard em:"
echo "  https://console.cloud.google.com/monitoring/dashboards?project=$PROJETO"
