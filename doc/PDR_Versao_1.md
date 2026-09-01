
### 1. Visão Geral e Objetivos

Implantar uma aplicação web de três camadas em uma arquitetura serverless de alta disponibilidade hospedada na Google Cloud Platform (GCP). A solução visa garantir a execução da aplicação com menor superfície de ataque, isolamento estrito da camada de dados, redundância geográfica na entrega da interface de usuário e centralização das chamadas públicas através de um proxy reverso sob HTTPS com domínio próprio.

---

### 2. Mapeamento de Serviços na Google Cloud Platform

**DNS e Gerenciamento de Nomes**
A resolução autoritativa de nomes é realizada pelo Cloud DNS. Ele responde pelas consultas dos subdomínios públicos associados à aplicação e encaminha os acessos para o endereço de IP estático do balanceador de carga.

**Proxy Reverso e Balanceamento de Carga**
O ponto de entrada único para o tráfego externo é o Global External HTTP(S) Load Balancer. Ele atua como proxy reverso de borda, realiza a terminação do tráfego seguro HTTPS com certificados SSL gerenciados pelo Google, faz o redirecionamento automático da porta HTTP (80) para a porta HTTPS (443) e gerencia o roteamento de caminhos para os serviços da interface e da API de navegação.

**Camada de Interface com o Usuário**
Os arquivos estáticos compilados para produção são armazenados em um bucket do Cloud Storage configurado para hospedagem web estática. A redundância e a entrega distribuída são garantidas pela integração com o Cloud CDN. Os arquivos da interface são replicados e mantidos em cache nos pontos de presença da infraestrutura global da GCP, garantindo alta disponibilidade e capacidade de atendimento mesmo em caso de falhas pontuais.

**Camada de Processamento e Regras de Negócio**
A aplicação em contêiner roda no Cloud Run a partir da imagem definida para o projeto. O serviço opera em modo serverless, escalando instâncias automaticamente de zero a N em resposta à demanda de requisições enviadas pelo proxy reverso.

**Camada de Armazenamento de Dados**
O banco de dados de documentos é provisionado em modelo gerenciado dentro do ecossistema GCP (como MongoDB Atlas integrado via GCP Marketplace ou instância totalmente privada no Compute Engine). O banco não possui IP público atribuído e opera exclusivamente dentro da VPC do projeto.

**Segurança e Controle de Conectividade Interna**
O tráfego de rede entre o serviço serverless Cloud Run e a rede privada da VPC é intermediado pelo Serverless VPC Access Connector. A filtragem de tráfego de borda e a prevenção contra requisições maliciosas são tratadas com políticas de segurança do Cloud Armor no balanceador de carga.

---

### 3. Ajustes de Configuração e Gestão de Variáveis

Para permitir a publicação na GCP sem alterar a lógica interna da aplicação, as configurações de rede hardcoded devem ser parametrizadas via variáveis de ambiente no processo de compilação e execução:

* **Ajuste na Interface do Usuário:** A URL base das chamadas HTTP deve deixar de apontar para o endereço local na porta 5000 e passar a ler uma variável de ambiente específica de API. Durante a etapa de compilação da aplicação, essa variável é preenchida com o endereço público do domínio configurado para os endpoints da aplicação.
* **Ajuste no Processamento da API:** A string de conexão com o banco de dados deve substituir a declaração estática do contêiner local pela leitura de uma variável de ambiente de banco. Essa variável é injetada no Cloud Run de forma segura através do Google Cloud Secret Manager.

---

### 4. Descrição dos Fluxos de Comunicação

**Fluxo de Requisição de Arquivos Estáticos**
O navegador do usuário consulta o Cloud DNS para resolver o subdomínio correspondente à interface. A consulta retorna o IP do Global External Load Balancer. O balanceador de carga recebe a chamada em HTTPS na porta 443, aplica as regras do Cloud Armor e entrega os arquivos estáticos recuperados a partir do nó do Cloud CDN mais próximo do usuário.

**Fluxo de Requisição de APIs e Regras de Negócio**
Quando a interface no navegador dispara requisições assíncronas para manipular as tarefas, a chamada é enviada ao subdomínio da API em HTTPS na porta 443. O balanceador de carga intercepta a requisição, valida o certificado SSL e a redireciona internamente para o Serverless Network Endpoint Group (NEG) associado ao Cloud Run. O Cloud Run processa as rotas e verbos HTTP correspondentes.

**Fluxo de Comunicação Interna com o Banco de Dados**
Para consultar ou persistir informações no banco de dados, o Cloud Run roteia o tráfego de saída através da sub-rede atribuída ao Serverless VPC Access Connector. A comunicação percorre os túneis internos da VPC até atingir o IP privado do banco na porta TCP 27017. Todo esse percurso é mantido isolado da internet pública.

---

### 5. Regras de Controle de Acesso e Segurança (Firewall)

* **Tráfego Internet para o Load Balancer (Porta 443/HTTPS):** Permitido. É o único ponto exposto para recebimento de requisições públicas.
* **Tráfego Internet para o Load Balancer (Porta 80/HTTP):** Permitido com redirecionamento forçado para a porta 443.
* **Tráfego Internet direto para a URL padrão do Cloud Run (.a.run.app):** Bloqueado. A regra de Ingress do Cloud Run é configurada estritamente para aceitar conexões vindas do balanceador de carga e do tráfego interno. Tentativas de acesso direto retornam erro HTTP 403.
* **Tráfego Internet direto para o Banco de Dados (Porta 27017/TCP):** Bloqueado. O banco não possui interface de rede externa configurada, gerando falha por timeout em qualquer tentativa de conexão vinda da internet.
* **Tráfego do Load Balancer para o Cloud Run:** Permitido via associação do Serverless NEG.
* **Tráfego do Serviço de Regras de Negócio para o Banco de Dados:** Permitido exclusivamente para os endereços IP originados na sub-rede do Serverless VPC Access Connector através das regras de firewall de entrada da VPC na porta 27017.

---

### 6. Roteiro para Validação e Testes de Conformidade

* **Validação da Interface e Redundância:** Acessar o subdomínio da aplicação via navegador ou utilitário de linha de comando, confirmando o status HTTP 200, a presença de um certificado SSL válido e os cabeçalhos de resposta indicando o atendimento da requisição por meio do Cloud CDN.
* **Validação do Proxy Reverso e das APIs:** Disparar uma chamada HTTP para a rota de listagem de tarefas no subdomínio da API. O retorno deve trazer a lista de objetos JSON com status HTTP 200, comprovando o repasse correto da requisição pelo balanceador de carga até o Cloud Run.
* **Validação do Bloqueio de Acesso Direto à Camada de Regras de Negócio:** Executar uma chamada utilizando a URL nativa fornecida pelo Cloud Run durante o deploy. O sistema deve recusar o acesso, retornando status HTTP 403 Forbidden.
* **Validação do Isolamento do Banco de Dados:** Tentar estabelecer conexão com o IP interno do banco de dados utilizando um cliente de banco a partir de uma rede externa. O acesso deve ser interrompido por timeout, comprovando a ausência de rotas públicas.
* **Validação do Fluxo de Dados Completo:** Inserir, alterar e excluir uma tarefa pela interface do usuário para demonstrar que a cadeia de comunicação completa (Interface do Usuário ➔ Proxy Reverso ➔ Serviço de Processamento ➔ VPC ➔ Banco de Dados) está operacional e funcional.