// Observabilidade do proxy reverso.
//
// O proxy roda na Vercel, fora do Google Cloud. Sem isto, nada do que ele
// decide chega ao Cloud Logging: qual regiao do front-end atendeu cada
// requisicao e quando houve failover ficariam invisiveis, e o painel de
// redundancia nao teria fonte de dados.
//
// Nenhuma credencial nova e introduzida. O mesmo token de acesso federado que
// o proxy ja obtem no STS para gerar o token de identidade serve para escrever
// no Cloud Logging; so foi preciso conceder roles/logging.logWriter a proxy-sa.

const LOGGING_URL = 'https://logging.googleapis.com/v2/entries:write';

const PROJETO = (process.env.GCP_PROJECT_ID || 'mensal2').trim();
const LOG_NAME = `projects/${PROJETO}/logs/proxy-vercel`;

// Sufixo da URL do Cloud Run -> regiao. O host e o unico lugar onde a regiao
// de destino aparece; traduzi-lo aqui e o que torna o painel de redundancia
// legivel ("southamerica-east1") em vez de crioptico ("-rj").
const REGIOES_POR_SUFIXO = {
  rj: 'southamerica-east1',
  uc: 'us-central1',
};

function regiaoDoDestino(destino) {
  try {
    const host = new URL(destino).host;
    const m = host.match(/-([a-z]{2})\.a\.run\.app$/);
    if (m) return REGIOES_POR_SUFIXO[m[1]] || m[1];
    return host;
  } catch {
    return 'desconhecida';
  }
}

// Apenas o primeiro segmento do caminho. Registrar o caminho inteiro colocaria
// o id do documento no log e estouraria a cardinalidade do painel; o prefixo
// basta para saber se a requisicao foi a API ou a um arquivo estatico.
function prefixoDoCaminho(url) {
  const caminho = (url || '/').split('?')[0];
  const primeiro = caminho.split('/').filter(Boolean)[0];
  return primeiro ? `/${primeiro}` : '/';
}

const classeDeStatus = (status) => `${Math.floor(status / 100)}xx`;

// Envia uma entrada ao Cloud Logging. Toda falha e engolida: um problema ao
// registrar jamais pode derrubar a requisicao que o proxy esta atendendo.
async function enviarAoCloudLogging(tokenDeAcesso, severidade, payload) {
  try {
    const resp = await fetch(LOGGING_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenDeAcesso}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        logName: LOG_NAME,
        resource: { type: 'global', labels: { project_id: PROJETO } },
        entries: [
          {
            severity: severidade,
            jsonPayload: payload,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });

    if (!resp.ok) {
      // Fica no log da propria Vercel, que e onde se procura quando o painel
      // de redundancia aparece vazio.
      console.error('Cloud Logging recusou a entrada:', resp.status, (await resp.text()).slice(0, 200));
    }
  } catch (err) {
    console.error('Falha ao enviar log ao Cloud Logging:', err && err.message);
  }
}

// waitUntil mantem a funcao serverless viva depois da resposta, para que o
// envio do log nao acrescente latencia ao usuario. Onde ele nao existir, o
// envio e aguardado: e preferivel um log lento a um log perdido.
let waitUntil;
try {
  ({ waitUntil } = require('@vercel/functions'));
} catch {
  waitUntil = null;
}

function registrarEncaminhamento(obterTokenDeAcesso, dados) {
  const severidade = dados.status >= 500 || dados.error_type ? 'ERROR' : 'INFO';

  const payload = {
    event: 'proxy_forward',
    service: 'proxy',
    env: process.env.VERCEL_ENV || 'local',
    ...dados,
    status_class: dados.status ? classeDeStatus(dados.status) : 'erro',
  };

  const tarefa = (async () => {
    const token = await obterTokenDeAcesso();
    if (!token) return; // sem identidade federada (execucao local): nada a enviar
    await enviarAoCloudLogging(token, severidade, payload);
  })().catch((err) => console.error('Observabilidade do proxy falhou:', err && err.message));

  if (waitUntil) {
    try {
      waitUntil(tarefa);
      return Promise.resolve();
    } catch {
      // Fora do contexto de requisicao da Vercel waitUntil lanca; cai no await.
    }
  }
  return tarefa;
}

module.exports = { registrarEncaminhamento, regiaoDoDestino, prefixoDoCaminho };
