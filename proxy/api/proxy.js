// Proxy reverso da aplicação.
//
// Recebe todas as requisições dos dois subdomínios e as encaminha:
//
//   200status.soarespedro.com.br      -> Cloud Run do front-end (regiao A, com failover para a B)
//   api.200status.soarespedro.com.br  -> Cloud Run do back-end
//
// Os tres servicos do Cloud Run sobem com --no-allow-unauthenticated e recusam
// qualquer chamada anonima. Somente este proxy consegue invoca-los.
//
// A identidade e obtida por Workload Identity Federation, sem nenhuma chave de
// longa duracao no repositorio ou nas variaveis de ambiente. O caminho e:
//
//   1. a Vercel injeta VERCEL_OIDC_TOKEN no runtime, com validade curta
//   2. esse token e trocado no STS do Google por um token de acesso federado
//   3. o token federado gera um token de identidade em nome da proxy-sa
//   4. o token de identidade acompanha a requisicao ao Cloud Run
//
// O passo 3 so funciona porque a condicao de atributo do provedor exige que o
// claim "sub" venha do deploy de producao deste projeto Vercel.

const STS_URL = 'https://sts.googleapis.com/v1/token';
const IAM_CREDENTIALS_URL = 'https://iamcredentials.googleapis.com/v1';

const WIF_AUDIENCE = process.env.GCP_WORKLOAD_IDENTITY_AUDIENCE;
const SERVICE_ACCOUNT = process.env.GCP_SERVICE_ACCOUNT_EMAIL;

const BACKEND_URL = process.env.BACKEND_URL;
const FRONTEND_PRIMARY = process.env.FRONTEND_URL_PRIMARY;
const FRONTEND_SECONDARY = process.env.FRONTEND_URL_SECONDARY;

// Tokens de identidade valem uma hora. Guardamos por destino e renovamos com
// folga, para nao repetir as duas chamadas de rede a cada requisicao.
const MARGEM_RENOVACAO_MS = 5 * 60 * 1000;
const tokensPorDestino = new Map();

async function trocarTokenNoSTS(tokenVercel) {
  const resp = await fetch(STS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audience: WIF_AUDIENCE,
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
      subjectToken: tokenVercel,
    }),
  });

  if (!resp.ok) {
    throw new Error(`STS recusou a troca (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  }

  return (await resp.json()).access_token;
}

async function gerarTokenDeIdentidade(tokenFederado, audience) {
  const url = `${IAM_CREDENTIALS_URL}/projects/-/serviceAccounts/${SERVICE_ACCOUNT}:generateIdToken`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenFederado}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ audience, includeEmail: true }),
  });

  if (!resp.ok) {
    throw new Error(`generateIdToken falhou (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  }

  return (await resp.json()).token;
}

async function getAuthHeaders(audience) {
  const tokenVercel = process.env.VERCEL_OIDC_TOKEN;

  // Sem token da Vercel nao ha identidade a federar. Isso so acontece em teste
  // local: em producao a ausencia do cabecalho faz o Cloud Run recusar com 403,
  // ou seja, a falha e fechada, nunca aberta.
  if (!tokenVercel || !WIF_AUDIENCE || !SERVICE_ACCOUNT) return {};

  const emCache = tokensPorDestino.get(audience);
  if (emCache && emCache.expiraEm > Date.now() + MARGEM_RENOVACAO_MS) {
    return { Authorization: `Bearer ${emCache.token}` };
  }

  const tokenFederado = await trocarTokenNoSTS(tokenVercel);
  const token = await gerarTokenDeIdentidade(tokenFederado, audience);

  tokensPorDestino.set(audience, { token, expiraEm: Date.now() + 60 * 60 * 1000 });
  return { Authorization: `Bearer ${token}` };
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
  'authorization',
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
    // ---- Rota da API: back-end privado ----
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
