// Instrumentacao de observabilidade do back-end.
//
// Tudo o que o Cloud Run recebe no stdout como uma linha JSON vira um
// jsonPayload estruturado no Cloud Logging, sem nenhuma biblioteca. Os campos
// "severity" e "message" sao lidos pelo proprio Cloud Run; o restante fica
// dentro de jsonPayload e e o que as log-based metrics extraem.
//
// Dois eventos sao emitidos:
//
//   event=http_request   uma linha por requisicao atendida
//   event=db_operation   uma linha por operacao no Firestore
//
// Os dois carregam o mesmo request_id, que e o que permite sair de um erro
// visto no painel e chegar a operacao de banco que o causou.

const PROJETO = process.env.GOOGLE_CLOUD_PROJECT || 'mensal2';
const SERVICO = process.env.K_SERVICE || 'backend';
const AMBIENTE = process.env.K_SERVICE ? 'producao' : 'local';
const REGIAO = process.env.REGION || 'desconhecida';

// Nunca registrar credencial, token ou o texto da tarefa do usuario.
// O que entra no log e sempre metadado: rota, resultado, duracao.

function registrar(nivel, mensagem, campos) {
  // JSON.stringify em uma unica linha: o Cloud Run separa registros por quebra
  // de linha, e um objeto multilinha viraria varios registros truncados.
  console.log(
    JSON.stringify({
      severity: nivel,
      message: mensagem,
      service: SERVICO,
      env: AMBIENTE,
      region: REGIAO,
      ...campos,
    })
  );
}

// O Cloud Run injeta X-Cloud-Trace-Context em toda requisicao. Aproveitar o
// trace de la, em vez de gerar um id proprio, faz o console agrupar
// automaticamente o http_request com os db_operation da mesma requisicao.
function traceDaRequisicao(req) {
  const cabecalho = req.headers['x-cloud-trace-context'];
  if (typeof cabecalho === 'string' && cabecalho.length > 0) {
    return cabecalho.split('/')[0];
  }
  // Fora do Cloud Run (teste local) nao ha trace: gera um identificador proprio
  // para que a correlacao continue funcionando.
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function classeDeStatus(status) {
  return `${Math.floor(status / 100)}xx`;
}

// Nome de negocio da operacao. E o rotulo que o painel de uso mostra: "criar
// tarefa" diz mais a quem le do que "POST /todos".
const OPERACOES = {
  'GET /todos': 'listar_tarefas',
  'POST /todos': 'criar_tarefa',
  'PATCH /todos/:id': 'concluir_tarefa',
  'DELETE /todos/:id': 'excluir_tarefa',
};

// Separa quem gerou a requisicao. Sem isso o proprio monitoramento entraria no
// painel de uso e o indicador mediria a si mesmo: a verificacao de
// disponibilidade bate na API a cada 5 minutos, para sempre, sem usuario algum.
function classificarCliente(userAgent) {
  const ua = (userAgent || '').toLowerCase();
  if (ua.includes('googlestackdrivermonitoring-uptimechecks')) return 'uptime';
  if (/bot|crawler|spider|slurp|gptbot|headlesschrome/.test(ua)) return 'bot';
  return 'app';
}

const agora = () => process.hrtime.bigint();
const msDesde = (inicio) => Number(agora() - inicio) / 1e6;

// Middleware de requisicao. Registrado antes das rotas, mas so emite o registro
// em res.on('finish'), quando status e duracao ja sao conhecidos.
function middlewareDeRequisicao(req, res, next) {
  const inicio = agora();
  const traceId = traceDaRequisicao(req);

  // Disponibiliza o contexto para que as operacoes de banco da mesma
  // requisicao sejam registradas com o mesmo identificador.
  req.observabilidade = { traceId, inicio };

  res.on('finish', () => {
    // req.route so existe depois do roteamento: e a rota padronizada
    // (/todos/:id), e nao o caminho concreto com o id do documento dentro.
    // Sem isso, cada PATCH viraria uma serie distinta no painel de desempenho.
    const rota = req.route ? req.route.path : 'nao_roteada';
    const chave = `${req.method} ${rota}`;

    registrar(res.statusCode >= 500 ? 'ERROR' : 'INFO', `${chave} ${res.statusCode}`, {
      event: 'http_request',
      request_id: traceId,
      'logging.googleapis.com/trace': `projects/${PROJETO}/traces/${traceId}`,
      method: req.method,
      route: rota,
      operation: OPERACOES[chave] || 'outra',
      status: res.statusCode,
      status_class: classeDeStatus(res.statusCode),
      duration_ms: Number(msDesde(inicio).toFixed(2)),
      client: classificarCliente(req.headers['user-agent']),
    });
  });

  next();
}

// Envolve uma operacao do Firestore, cronometra e registra o desfecho.
// Em caso de falha, registra e relanca: quem chama continua responsavel pela
// resposta HTTP, a instrumentacao nao altera o comportamento das rotas.
async function medirBanco(req, operacao, executar) {
  const inicio = agora();
  const traceId = (req.observabilidade && req.observabilidade.traceId) || 'sem_trace';

  const base = {
    event: 'db_operation',
    request_id: traceId,
    'logging.googleapis.com/trace': `projects/${PROJETO}/traces/${traceId}`,
    operation: operacao,
    collection: 'todos',
  };

  try {
    const resultado = await executar();
    registrar('INFO', `firestore ${operacao} ok`, {
      ...base,
      result: 'success',
      duration_ms: Number(msDesde(inicio).toFixed(2)),
    });
    return resultado;
  } catch (err) {
    registrar('ERROR', `firestore ${operacao} falhou`, {
      ...base,
      result: 'error',
      duration_ms: Number(msDesde(inicio).toFixed(2)),
      // err.code do Firestore e um numero de status gRPC (7 = PERMISSION_DENIED).
      // Guardar o nome da classe como alternativa cobre os erros que nao o trazem.
      error_type: String(err.code || err.constructor.name),
      // A mensagem do SDK descreve a falha e nao carrega credencial; o corte
      // evita que um stack longo inche o registro.
      error_message: String(err.message || '').slice(0, 300),
    });
    throw err;
  }
}

module.exports = { registrar, middlewareDeRequisicao, medirBanco };
