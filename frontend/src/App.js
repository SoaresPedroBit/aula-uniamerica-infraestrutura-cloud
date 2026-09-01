import React, { useState, useEffect } from 'react';
import axios from 'axios';
import Swal from 'sweetalert2';
import './App.css';

function App() {
  const [todos, setTodos] = useState([]);
  const [task, setTask] = useState(""); 

  // Função para carregar os todos da API
  const fetchTodos = async () => {
    const response = await axios.get('http://localhost:5000/todos');
    setTodos(response.data);
  };

  // Função para adicionar uma nova tarefa
  const addTodo = async () => {
    if (task.trim()) {
      const response = await axios.post('http://localhost:5000/todos', { text: task });
      setTodos([...todos, response.data]);
      setTask("");
    }
  };

  // Função para marcar a tarefa como concluída
  const toggleComplete = async (id) => {
    const response = await axios.patch(`http://localhost:5000/todos/${id}`);
    const updatedTodos = todos.map(todo =>
      todo._id === id ? response.data : todo
    );
    setTodos(updatedTodos);
  };

  // Função para excluir a tarefa
  const deleteTodo = async (id) => {
    const result = await Swal.fire({
      title: 'Tem certeza?',
      text: 'Essa tarefa será excluída permanentemente!',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#f44336',
      cancelButtonColor: '#6c757d',
      confirmButtonText: 'Sim, excluir',
      cancelButtonText: 'Cancelar'
    });

    if (result.isConfirmed) {
      await axios.delete(`http://localhost:5000/todos/${id}`);
      setTodos(todos.filter(todo => todo._id !== id));

      await Swal.fire({
        title: 'Excluída!',
        text: 'A tarefa foi excluída com sucesso.',
        icon: 'success',
        confirmButtonText: 'OK'
      });
    }
  };

  // Carregar a lista de todos ao iniciar o componente
  useEffect(() => {
    fetchTodos();
  }, []);

  return (
    <div className="App">
      <h1>Lista de Tarefas</h1>

      <div className="input-container">
        <input 
          type="text" 
          value={task} 
          onChange={(e) => setTask(e.target.value)} 
          placeholder="Adicione uma tarefa"
        />
        <button onClick={addTodo}>Adicionar</button>
      </div>

      <ul>
        {todos.map((todo) => (
          <li key={todo._id}>
            <span
              onClick={() => toggleComplete(todo._id)}
              style={{
                textDecoration: todo.completed ? "line-through" : "none"
              }}
            >
              {todo.text}
            </span>

            <button onClick={() => deleteTodo(todo._id)}>
              Excluir
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default App;