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
//   1. a Vercel entrega um token OIDC de validade curta no cabecalho
//      x-vercel-oidc-token de cada requisicao
//   2. esse token e trocado no STS do Google por um token de acesso federado
//   3. o token federado gera um token de identidade em nome da proxy-sa
//   4. o token de identidade acompanha a requisicao ao Cloud Run
//
// O passo 3 so funciona porque a condicao de atributo do provedor exige que o
// claim "sub" venha do deploy de producao deste projeto Vercel.

const {
  registrarEncaminhamento,
  regiaoDoDestino,
  prefixoDoCaminho,
} = require('../lib/observabilidade');

const STS_URL = 'https://sts.googleapis.com/v1/token';
const IAM_CREDENTIALS_URL = 'https://iamcredentials.googleapis.com/v1';

// Valores colados em painel web costumam trazer espaco ou quebra de linha
// invisivel na ponta, o que o STS rejeita sem explicar. Normalizamos na leitura.
const env = (nome) => (process.env[nome] || '').trim();

const WIF_AUDIENCE = env('GCP_WORKLOAD_IDENTITY_AUDIENCE');

// E-mail de service account nunca termina em ponto. Quando termina, e ponto
// final de frase que veio junto na colagem, e o Google recusa com
// "Invalid form of account ID".
const SERVICE_ACCOUNT = env('GCP_SERVICE_ACCOUNT_EMAIL').replace(/\.+$/, '');

const BACKEND_URL = env('BACKEND_URL');
const FRONTEND_PRIMARY = env('FRONTEND_URL_PRIMARY');
const FRONTEND_SECONDARY = env('FRONTEND_URL_SECONDARY');

// Tokens de identidade valem uma hora. Guardamos por destino e renovamos com
// folga, para nao repetir as duas chamadas de rede a cada requisicao.
const MARGEM_RENOVACAO_MS = 5 * 60 * 1000;
const tokensPorDestino = new Map();

// O token de acesso federado passou a ser reaproveitado. Antes era usado uma
// unica vez para gerar o token de identidade e descartado; agora ele tambem
// autentica a escrita no Cloud Logging, e cachea-lo evita uma ida ao STS por
// requisicao.
let tokenFederadoEmCache = null;

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
    // O audience e um nome de recurso publico, nao um segredo: registra-lo
    // aqui e o que permite diagnosticar valor colado errado.
    throw new Error(
      `STS recusou a troca (${resp.status}) para audience [${WIF_AUDIENCE}]: ` +
        (await resp.text()).slice(0, 200)
    );
  }

  const dados = await resp.json();
  return {
    token: dados.access_token,
    // expires_in vem em segundos; na ausencia dele assume-se o minimo seguro.
    expiraEm: Date.now() + (Number(dados.expires_in) || 600) * 1000,
  };
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
    throw new Error(
      `generateIdToken falhou (${resp.status}) para a conta [${SERVICE_ACCOUNT}]: ` +
        (await resp.text()).slice(0, 200)
    );
  }

  return (await resp.json()).token;
}

// Token de acesso federado, usado tanto para gerar tokens de identidade quanto
// para escrever no Cloud Logging.
async function getTokenFederado(req) {
  // Em producao a Vercel entrega o token no cabecalho da requisicao; a variavel
  // de ambiente so existe em desenvolvimento local (vercel env pull).
  const tokenVercel = req.headers['x-vercel-oidc-token'] || process.env.VERCEL_OIDC_TOKEN;

  // Sem token da Vercel nao ha identidade a federar. Isso so acontece em teste
  // local: em producao a ausencia do cabecalho faz o Cloud Run recusar com 403,
  // ou seja, a falha e fechada, nunca aberta.
  if (!tokenVercel || !WIF_AUDIENCE || !SERVICE_ACCOUNT) return null;

  if (tokenFederadoEmCache && tokenFederadoEmCache.expiraEm > Date.now() + MARGEM_RENOVACAO_MS) {
    return tokenFederadoEmCache.token;
  }

  tokenFederadoEmCache = await trocarTokenNoSTS(tokenVercel);
  return tokenFederadoEmCache.token;
}

async function getAuthHeaders(audience, req) {
  const tokenFederado = await getTokenFederado(req);
  if (!tokenFederado) return {};

  const emCache = tokensPorDestino.get(audience);
  if (emCache && emCache.expiraEm > Date.now() + MARGEM_RENOVACAO_MS) {
    return { Authorization: `Bearer ${emCache.token}` };
  }

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
  // Credencial da Vercel: e consumida aqui para gerar o token do Google e
  // jamais pode seguir adiante, sob risco de vazar identidade ao destino.
  'x-vercel-oidc-token',
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
  const inicio = Date.now();

  // Fechamento que entrega o token de acesso ao modulo de observabilidade sem
  // que ele precise conhecer a cadeia de federacao.
  const obterToken = () => getTokenFederado(req).catch(() => null);

  const registrar = (dados) =>
    registrarEncaminhamento(obterToken, {
      host,
      method: req.method,
      path_prefix: prefixoDoCaminho(req.url),
      duration_ms: Date.now() - inicio,
      ...dados,
    });

  try {
    // ---- Rota da API: back-end privado ----
    if (host.startsWith('api.')) {
      if (!BACKEND_URL) {
        registrar({ target: 'backend', status: 503, error_type: 'backend_url_ausente' });
        return res.status(503).json({ message: 'BACKEND_URL nao configurada' });
      }

      const auth = await getAuthHeaders(BACKEND_URL, req);
      const upstream = await encaminhar(BACKEND_URL, req, auth);

      registrar({
        target: 'backend',
        target_region: regiaoDoDestino(BACKEND_URL),
        status: upstream.status,
        failover: false,
        tentativas: 1,
      });

      return responder(res, upstream);
    }

    // ---- Rota do front-end: duas regioes, com failover ----
    const regioes = [FRONTEND_PRIMARY, FRONTEND_SECONDARY].filter(Boolean);

    if (regioes.length === 0) {
      registrar({ target: 'frontend', status: 503, error_type: 'nenhuma_regiao_configurada' });
      return res.status(503).json({ message: 'Nenhuma regiao de front-end configurada' });
    }

    let ultimoErro;
    let tentativas = 0;

    for (const regiao of regioes) {
      tentativas += 1;
      const ehPrimaria = tentativas === 1;

      try {
        // As duas regioes tambem sobem privadas, para que o front-end so possa
        // ser alcancado pelo dominio configurado e nunca pela URL .run.app.
        const auth = await getAuthHeaders(regiao, req);
        const upstream = await encaminhar(regiao, req, auth);

        // 5xx indica regiao doente: tenta a proxima antes de desistir
        if (upstream.status >= 500 && regiao !== regioes[regioes.length - 1]) {
          // A tentativa recusada tambem vira registro: e ela que revela o
          // momento exato em que a regiao adoeceu, e nao apenas que o usuario
          // acabou atendido.
          registrar({
            target: 'frontend_primario',
            target_region: regiaoDoDestino(regiao),
            status: upstream.status,
            failover: false,
            tentativas,
            error_type: 'regiao_respondeu_5xx',
          });
          ultimoErro = new Error(`Regiao ${regiao} respondeu ${upstream.status}`);
          continue;
        }

        registrar({
          target: ehPrimaria ? 'frontend_primario' : 'frontend_secundario',
          target_region: regiaoDoDestino(regiao),
          status: upstream.status,
          // A requisicao so e failover se alguma regiao anterior ja falhou.
          failover: !ehPrimaria,
          tentativas,
        });

        res.setHeader('X-Origem-Regiao', regiao);
        return responder(res, upstream);
      } catch (err) {
        // Falha de rede: cai para a proxima regiao
        registrar({
          target: ehPrimaria ? 'frontend_primario' : 'frontend_secundario',
          target_region: regiaoDoDestino(regiao),
          failover: !ehPrimaria,
          tentativas,
          error_type: 'falha_de_rede',
        });
        ultimoErro = err;
      }
    }

    console.error('Todas as regioes do front-end falharam:', ultimoErro && ultimoErro.message);
    registrar({
      target: 'frontend',
      status: 502,
      failover: true,
      tentativas,
      error_type: 'todas_as_regioes_falharam',
    });
    return res.status(502).json({ message: 'Front-end indisponivel em todas as regioes' });
  } catch (err) {
    console.error('Erro no proxy:', err);
    registrar({ status: 502, error_type: 'erro_no_proxy' });
    return res.status(502).json({ message: 'Erro ao encaminhar a requisicao' });
  }
};
