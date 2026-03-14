FROM node:18-alpine

# Install Docker CLI and Git so the container can execute docker commands on the host daemon and clone repositories
RUN apk add --no-cache docker-cli git

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Bundle app source
COPY . .

# Expose webhook port
EXPOSE 3000

# Start server
CMD [ "npm", "start" ]
