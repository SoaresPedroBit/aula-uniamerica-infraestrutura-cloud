# Etapa 1: Construção da aplicação
FROM node:18-alpine as build

# Definindo o diretório de trabalho dentro do container
WORKDIR /app

# Copiando o package.json e o package-lock.json para instalar as dependências
COPY package*.json ./

# Instalando as dependências do projeto
RUN npm install

# Copiando todo o conteúdo da pasta do projeto para o container
COPY . .

# Construindo a aplicação para produção.
# A URL da API vem de .env.production, lido automaticamente pelo Create React App.
RUN npm run build

# Etapa 2: Servindo a aplicação
FROM nginx:alpine

# Copiando o build da etapa anterior para o diretório padrão do Nginx
COPY --from=build /app/build /usr/share/nginx/html

# Configuração servida a partir de um template: a imagem oficial do nginx roda
# envsubst sobre /etc/nginx/templates/*.template antes de subir, o que permite
# a cada região se identificar pela variável REGION do deploy.
COPY default.conf.template /etc/nginx/templates/default.conf.template

# Expondo a porta 80 para acesso à aplicação
EXPOSE 80

# Comando para iniciar o Nginx e servir a aplicação
CMD ["nginx", "-g", "daemon off;"]
