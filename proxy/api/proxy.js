// Proxy reverso da aplicação.
//
// Recebe todas as requisições dos dois subdomínios e as encaminha:
//
//   200status.soarespedro.com.br      -> Cloud Run do front-end (regiao A, com failover para a B)
//   api.200status.soarespedro.com.br  -> Cloud Run do back-end (privado, exige token OIDC)
//
// O back-end sobe com --no-allow-unauthenticated, ou seja, recusa qualquer
// chamada anonima da Internet. Somente este proxy consegue invoca-lo, porque
// assina um token OIDC com a service account autorizada.

const { GoogleAuth } = require('google-auth-library');

const BACKEND_URL = process.env.BACKEND_URL;
const FRONTEND_PRIMARY = process.env.FRONTEND_URL_PRIMARY;
const FRONTEND_SECONDARY = process.env.FRONTEND_URL_SECONDARY;

// Clientes de identidade reaproveitados entre invocacoes quentes da funcao,
// um por destino, para nao assinar um token novo a cada requisicao.
const clientesPorDestino = new Map();

async function getAuthHeaders(audience) {
  // Sem chave configurada nao ha o que assinar. Isso so acontece em teste local:
  // em producao a ausencia do cabecalho faz o Cloud Run recusar com 403, ou seja,
  // a falha e fechada, nunca aberta.
  if (!process.env.GCP_SERVICE_ACCOUNT_KEY) return {};

  if (!clientesPorDestino.has(audience)) {
    const credentials = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY);
    const auth = new GoogleAuth({ credentials });
    clientesPorDestino.set(audience, await auth.getIdTokenClient(audience));
  }

  const headers = await clientesPorDestino.get(audience).getRequestHeaders();
  // Versoes recentes da biblioteca devolvem um objeto Headers em vez de um objeto simples.
  return typeof headers.entries === 'function' ? Object.fromEntries(headers.entries()) : headers;
}

// Cabecalhos que nao podem ser repassados adiante: ou pertencem a conexao
// com a Vercel, ou seriam sobrescritos pelo destino.
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'content-length',
]);

function repassarCabecalhos(req) {
  const headers = {};
  for (const [nome, valor] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(nome.toLowerCase())) {
      headers[nome] = Array.isArray(valor) ? valor.join(', ') : valor;
    }
  }
  return headers;
}

function corpoDaRequisicao(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  if (req.body === undefined || req.body === null) return undefined;
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) return req.body;
  return JSON.stringify(req.body);
}

async function encaminhar(destino, req, cabecalhosExtras = {}) {
  const url = new URL(req.url, destino);
  const alvo = new URL(destino);
  url.protocol = alvo.protocol;
  url.host = alvo.host;

  return fetch(url.toString(), {
    method: req.method,
    headers: { ...repassarCabecalhos(req), ...cabecalhosExtras },
    body: corpoDaRequisicao(req),
    redirect: 'manual',
  });
}

async function responder(res, upstream) {
  res.status(upstream.status);

  upstream.headers.forEach((valor, nome) => {
    // content-encoding e content-length ja foram resolvidos pelo fetch ao ler o corpo
    if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(nome)) {
      res.setHeader(nome, valor);
    }
  });

  const corpo = Buffer.from(await upstream.arrayBuffer());
  res.send(corpo);
}

module.exports = async (req, res) => {
  const host = (req.headers.host || '').toLowerCase();

  try {
    // ---- Rota da API: back-end privado, exige token OIDC ----
    if (host.startsWith('api.')) {
      if (!BACKEND_URL) {
        return res.status(503).json({ message: 'BACKEND_URL nao configurada' });
      }

      const auth = await getAuthHeaders(BACKEND_URL);
      const upstream = await encaminhar(BACKEND_URL, req, auth);
      return responder(res, upstream);
    }

    // ---- Rota do front-end: duas regioes, com failover ----
    const regioes = [FRONTEND_PRIMARY, FRONTEND_SECONDARY].filter(Boolean);

    if (regioes.length === 0) {
      return res.status(503).json({ message: 'Nenhuma regiao de front-end configurada' });
    }

    let ultimoErro;

    for (const regiao of regioes) {
      try {
        // As duas regioes tambem sobem privadas, para que o front-end so possa
        // ser alcancado pelo dominio configurado e nunca pela URL .run.app.
        const auth = await getAuthHeaders(regiao);
        const upstream = await encaminhar(regiao, req, auth);

        // 5xx indica regiao doente: tenta a proxima antes de desistir
        if (upstream.status >= 500 && regiao !== regioes[regioes.length - 1]) {
          ultimoErro = new Error(`Regiao ${regiao} respondeu ${upstream.status}`);
          continue;
        }

        res.setHeader('X-Origem-Regiao', regiao);
        return responder(res, upstream);
      } catch (err) {
        // Falha de rede: cai para a proxima regiao
        ultimoErro = err;
      }
    }

    console.error('Todas as regioes do front-end falharam:', ultimoErro && ultimoErro.message);
    return res.status(502).json({ message: 'Front-end indisponivel em todas as regioes' });
  } catch (err) {
    console.error('Erro no proxy:', err);
    return res.status(502).json({ message: 'Erro ao encaminhar a requisicao' });
  }
};
