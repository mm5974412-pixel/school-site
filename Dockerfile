FROM node:20-alpine

# Рабочая директория внутри контейнера
WORKDIR /app

# Копируем package.json и package-lock.json (если есть)
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install --production

# Копируем весь проект
COPY . .

# Переменная порта (Railway сам передаст PORT)
ENV PORT=3000
EXPOSE 3000

# Команда запуска
CMD ["npm", "start"]
