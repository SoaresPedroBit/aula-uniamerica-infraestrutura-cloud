const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Firestore } = require('@google-cloud/firestore');
const { registrar, middlewareDeRequisicao, medirBanco } = require('./observabilidade');

// Inicializando o app Express
const app = express();

// A porta vem do ambiente: o Cloud Run injeta PORT (8080 por padrão)
const port = process.env.PORT || 5000;

// Conexão com o Firestore.
// Não há string de conexão nem senha: a autenticação usa as credenciais
// da service account do próprio Cloud Run (Application Default Credentials).
const firestore = new Firestore();
const todosCollection = firestore.collection('todos');

// CORS restrito: somente o domínio do front-end pode chamar esta API.
// Em desenvolvimento cai para o servidor local do React.
const allowedOrigins = (process.env.ALLOWED_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim());

// Registrado antes de tudo: mede a requisição inteira, inclusive o tempo
// gasto no parse do corpo e em eventual recusa do CORS.
app.use(middlewareDeRequisicao);

app.use(cors({ origin: allowedOrigins }));
app.use(bodyParser.json());

// Converte um documento do Firestore no formato que o front-end espera
const toTodo = (doc) => ({ _id: doc.id, ...doc.data() });

// Rota para obter todas as tarefas (GET)
app.get('/todos', async (req, res) => {
  try {
    // Retorna todas as tarefas do banco
    const snapshot = await medirBanco(req, 'listar', () => todosCollection.get());
    res.json(snapshot.docs.map(toTodo));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Rota para adicionar uma nova tarefa (POST)
app.post('/todos', async (req, res) => {
  const { text } = req.body; // Obtém o texto da tarefa do corpo da requisição

  // Verifica se o campo "text" está presente
  if (!text) {
    return res.status(400).json({ message: 'O campo "text" é obrigatório' });
  }

  try {
    // Salva a tarefa no banco
    const docRef = await medirBanco(req, 'inserir', () =>
      todosCollection.add({ text, completed: false })
    );
    const doc = await medirBanco(req, 'ler_documento', () => docRef.get());
    res.status(201).json(toTodo(doc)); // Retorna a tarefa criada
  } catch (err) {
    res.status(400).json({ message: err.message }); // Retorna erro se houver falha no banco de dados
  }
});

// Rota para marcar uma tarefa como concluída (PATCH)
app.patch('/todos/:id', async (req, res) => {
  try {
    const docRef = todosCollection.doc(req.params.id); // Encontra a tarefa pelo ID
    const doc = await medirBanco(req, 'ler_documento', () => docRef.get());

    if (!doc.exists) {
      return res.status(404).json({ message: 'Tarefa não encontrada' });
    }

    // Alterna o status de "completed" da tarefa
    await medirBanco(req, 'atualizar', () =>
      docRef.update({ completed: !doc.data().completed })
    );
    // Recarrega a tarefa modificada
    const updated = await medirBanco(req, 'ler_documento', () => docRef.get());
    res.json(toTodo(updated)); // Retorna a tarefa atualizada
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Rota para excluir uma tarefa (DELETE)
app.delete('/todos/:id', async (req, res) => {
  try {
    const docRef = todosCollection.doc(req.params.id);
    const doc = await medirBanco(req, 'ler_documento', () => docRef.get());

    if (!doc.exists) {
      return res.status(404).json({ message: 'Tarefa não encontrada' });
    }

    await medirBanco(req, 'excluir', () => docRef.delete()); // Deleta a tarefa pelo ID
    res.json({ message: 'Tarefa excluída com sucesso' }); // Retorna uma mensagem de sucesso
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Iniciando o servidor
app.listen(port, () => {
  registrar('INFO', `Servidor rodando na porta ${port}`, { event: 'startup', port });
});
