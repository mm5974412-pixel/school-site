const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const session = require("express-session");
const bcrypt = require("bcryptjs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Порт: локально 3000, на Render — тот, который он даёт
const PORT = process.env.PORT || 3000;

// Чтобы читать данные из форм
app.use(express.urlencoded({ extended: true }));

// СЕССИИ: тут хранится, кто вошёл
app.use(
  session({
    secret: "замени_эту_строку_на_что-то_сложное", // в реальном проекте вынести в переменные окружения
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24, // 1 день
    },
  })
);

// ======= ДАННЫЕ В ПАМЯТИ (пока без базы) =======
let users = []; // { username, passwordHash }
let messages = []; // { author, text, time }

// ======= РОУТ ДЛЯ ЧАТА (ПРОВЕРКА ВХОДА) =======

app.get("/chat", (req, res) => {
  if (!req.session.user) {
    // Если не вошёл — отправляем на логин
    return res.redirect("/login.html");
  }
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

// Статические файлы (главная, логин, регистрация, стили)
app.use(express.static(path.join(__dirname, "public")));

// ======= РЕГИСТРАЦИЯ (с хешированием пароля) =======

app.post("/register", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.send(
      "Логин и пароль обязательны. <a href='/register.html'>Назад</a>"
    );
  }

  const existingUser = users.find((u) => u.username === username);
  if (existingUser) {
    return res.send(
      "Такой логин уже занят. <a href='/register.html'>Попробовать другой</a>"
    );
  }

  // ШИФРУЕМ пароль
  const passwordHash = await bcrypt.hash(password, 10);

  users.push({ username, passwordHash });
  console.log("Новый пользователь зарегистрирован:", username);

  res.redirect("/login.html");
});

// ======= ВХОД (проверка по хешу + сессия) =======

app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const user = users.find((u) => u.username === username);
  if (!user) {
    return res.send(
      "Неверный логин или пароль. <a href='/login.html'>Попробовать снова</a>"
    );
  }

  // Сравниваем введённый пароль с захешированным
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.send(
      "Неверный логин или пароль. <a href='/login.html'>Попробовать снова</a>"
    );
  }

  // Сохраняем пользователя в сессии
  req.session.user = { username: user.username };

  console.log("Пользователь вошёл:", username);
  res.redirect("/chat");
});

// ======= КТО Я (для chat.html) =======

app.get("/me", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ loggedIn: false });
  }
  res.json({ loggedIn: true, username: req.session.user.username });
});

// ======= ВЫХОД (по желанию) =======
app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login.html");
  });
});

// ======= SOCKET.IO (чат) =======

io.on("connection", (socket) => {
  console.log("Новый пользователь подключился:", socket.id);

  // История сообщений
  socket.emit("chat-history", messages);

  // Новые сообщения
  socket.on("chat-message", (data) => {
    // data: { author, text, time }
    messages.push(data);
    io.emit("chat-message", data);
  });

  socket.on("disconnect", () => {
    console.log("Пользователь отключился:", socket.id);
  });
});

// ======= ЗАПУСК СЕРВЕРА =======

server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
