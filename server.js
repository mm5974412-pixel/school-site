const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Чтобы Express понимал данные из форм (POST)
app.use(express.urlencoded({ extended: true }));

// Отдаём статические файлы из папки public
app.use(express.static(path.join(__dirname, "public")));

// Простейшее хранилище пользователей и сообщений в памяти
// В РЕАЛЬНОМ ПРОЕКТЕ нужно использовать базу данных
let users = []; // { username, password }
let messages = []; // { author, text, time }

// ====== Маршруты регистрации и входа ======

// Обработка регистрации
app.post("/register", (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.send("Логин и пароль обязательны. <a href='/register.html'>Назад</a>");
  }

  // Проверка, что пользователь с таким именем уже существует
  const existingUser = users.find((u) => u.username === username);
  if (existingUser) {
    return res.send("Такой логин уже занят. <a href='/register.html'>Попробовать другой</a>");
  }

  users.push({ username, password });

  console.log("Новый пользователь зарегистрирован:", username);
  // После регистрации отправляем на страницу входа
  res.redirect("/login.html");
});

// Обработка входа
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  const user = users.find(
    (u) => u.username === username && u.password === password
  );

  if (!user) {
    return res.send("Неверный логин или пароль. <a href='/login.html'>Попробовать снова</a>");
  }

  console.log("Пользователь вошёл:", username);

  // Перенаправляем в чат, передавая имя пользователя в адресной строке
  res.redirect(`/chat.html?user=${encodeURIComponent(username)}`);
});

// ====== Работа сокетов (мессенджер) ======
io.on("connection", (socket) => {
  console.log("Новый пользователь подключился:", socket.id);

  // Отправляем историю сообщений только что подключившемуся
  socket.emit("chat-history", messages);

  // Слушаем входящие сообщения
  socket.on("chat-message", (data) => {
    // data: { author, text, time }
    messages.push(data);

    // Рассылаем сообщение всем подключённым
    io.emit("chat-message", data);
  });

  socket.on("disconnect", () => {
    console.log("Пользователь отключился:", socket.id);
  });
});

// Запуск сервера
server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
