# Objetivo

Nesta atividade, você deve utilizar uma aplicação já existente e construir uma infraestrutura serverless na nuvem, aplicando conceitos básicos de segurança, controle de acesso, DNS, proxy reverso e redundância.

A aplicação possui três componentes principais:

* Frontend
* Backend
* Banco de Dados

O objetivo é fazer a aplicação funcionar em um ambiente de nuvem, garantindo que cada componente tenha o nível adequado de proteção.

# Requisitos

### 1. Frontend

O Frontend deverá:

* Estar disponível para acesso pela Internet;
* Utilizar uma solução serverless;
* Utilizar HTTPS;
* Possuir redundância, com pelo menos dois pontos de execução/atendimento;
* Possuir um mecanismo responsável por distribuir o acesso;
* Possuir um domínio ou subdomínio próprio.

O acesso ao Frontend deverá ocorrer através do domínio configurado, e não diretamente pelo endereço fornecido pelo serviço de nuvem. Caso não haja um domínio próprio, entrar em contato com o professor passando um IP público e o nome do subdomínio a ser criado.

### 2. Backend

O Backend deverá:

* Utilizar uma solução serverless;
* Não estar diretamente exposto à Internet;
* Ser acessado através de uma API;
* Possuir regras de acesso definidas;
* Utilizar proxy reverso para encaminhar as requisições ao serviço do Backend.

O acesso à aplicação deverá utilizar o domínio configurado para o Backend.

### 3. Banco de Dados

O Banco de Dados deverá:

* Utilizar um serviço gerenciado/serverless;
* Não possuir acesso público;
* Ser acessível somente pelo Backend;
* Possuir controle de acesso configurado **(OPCIONAL)**.

No diagrama, demonstrem que o acesso:

* **Internet → Banco de Dados** é bloqueado.
* **Backend → Banco de Dados** é permitido.

### 4. Domínio e Proxy Reverso

A aplicação deverá utilizar domínio/subdomínio para acesso ao Frontend e ao Backend.

O fluxo esperado deverá ser representado no diagrama:

* **Frontend:**
`Usuário → DNS → Proxy Reverso → Frontend`
* **Back-end:**
`Frontend → DNS/API → Proxy Reverso → Backend`

O proxy reverso deverá ser responsável por receber as requisições e encaminhá-las para o serviço correspondente.

Você devera demonstrar no diagrama:

* Domínio utilizado;
* DNS;
* Proxy reverso;
* Frontend;
* Backend;
* Fluxo das requisições;
* HTTPS;
* Regras de segurança.

### 5. Segurança

Para cada componente da infraestrutura, vocês deverão indicar no diagrama o firewall ou mecanismo equivalente de controle de acesso.

O diagrama deverá deixar claro:

* Quem pode acessar;
* Quem não pode acessar;
* Qual porta é utilizada;
* Qual protocolo é utilizado;
* Onde o acesso é bloqueado.

> **Regra Geral:** Tudo deve ser bloqueado, exceto aquilo que for necessário para o funcionamento da aplicação.
