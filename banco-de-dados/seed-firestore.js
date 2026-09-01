// Popula a coleção "todos" do Firestore com os dados iniciais.
// Substitui o antigo init-mongo.js.
//
// Uso:
//   gcloud auth application-default login
//   gcloud config set project SEU_PROJETO
//   npm install && node seed-firestore.js

const { Firestore } = require('@google-cloud/firestore');

const firestore = new Firestore();

const todosIniciais = [
  { text: 'Laércio é um excelente professor', completed: false },
  { text: 'Estudar Cloud', completed: true },
  { text: 'Fazer exercícios da UA', completed: false },
];

(async () => {
  const colecao = firestore.collection('todos');
  const batch = firestore.batch();

  todosIniciais.forEach((todo) => batch.set(colecao.doc(), todo));
  await batch.commit();

  console.log(`${todosIniciais.length} tarefas inseridas na coleção "todos".`);
})().catch((err) => {
  console.error('Erro ao popular o Firestore:', err.message);
  process.exit(1);
});
