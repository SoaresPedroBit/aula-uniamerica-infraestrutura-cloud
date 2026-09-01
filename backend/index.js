const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Firestore } = require('@google-cloud/firestore');

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

app.use(cors({ origin: allowedOrigins }));
app.use(bodyParser.json());

// Converte um documento do Firestore no formato que o front-end espera
const toTodo = (doc) => ({ _id: doc.id, ...doc.data() });

// Rota para obter todas as tarefas (GET)
app.get('/todos', async (req, res) => {
  try {
    const snapshot = await todosCollection.get(); // Retorna todas as tarefas do banco
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
    const docRef = await todosCollection.add({ text, completed: false }); // Salva a tarefa no banco
    const doc = await docRef.get();
    res.status(201).json(toTodo(doc)); // Retorna a tarefa criada
  } catch (err) {
    res.status(400).json({ message: err.message }); // Retorna erro se houver falha no banco de dados
  }
});

// Rota para marcar uma tarefa como concluída (PATCH)
app.patch('/todos/:id', async (req, res) => {
  try {
    const docRef = todosCollection.doc(req.params.id); // Encontra a tarefa pelo ID
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Tarefa não encontrada' });
    }

    // Alterna o status de "completed" da tarefa
    await docRef.update({ completed: !doc.data().completed });
    const updated = await docRef.get(); // Recarrega a tarefa modificada
    res.json(toTodo(updated)); // Retorna a tarefa atualizada
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Rota para excluir uma tarefa (DELETE)
app.delete('/todos/:id', async (req, res) => {
  try {
    const docRef = todosCollection.doc(req.params.id);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: 'Tarefa não encontrada' });
    }

    await docRef.delete(); // Deleta a tarefa pelo ID
    res.json({ message: 'Tarefa excluída com sucesso' }); // Retorna uma mensagem de sucesso
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Iniciando o servidor
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
