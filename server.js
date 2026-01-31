require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const multer = require("multer");
const fs = require("fs");
const rateLimit = require("express-rate-limit");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Глобальное хранилище подключённых пользователей
const onlineUsers = new Map(); // { userId: { socketId, username, connectedAt } }

// Глобальное хранилище статусов пользователей
// { userId: { status: 'online'|'offline'|'typing'|'recording_voice'|'sending_photo'|'sending_video', statusData: { ...meta } } }
const userStatuses = new Map();

// ======= SOCKET.IO: комнаты для личных чатов =======
io.on("connection", (socket) => {
  console.log("Socket connected", socket.id);

  // Пользователь подключается и отправляет свой ID
  socket.on("user-online", (userId) => {
    if (userId && !onlineUsers.has(userId)) {
      onlineUsers.set(userId, {
        socketId: socket.id,
        userId,
        connectedAt: new Date()
      });
      console.log(`User ${userId} is online. Total online: ${onlineUsers.size}`);
      io.emit("stats-update", {
        onlineUsers: onlineUsers.size
      });
    }
  });

  // Пользователь заходит в чат
  socket.on("join-chat", (chatId) => {
    if (!chatId) return;
    socket.join(`chat:${chatId}`);
  });

  // Пользователь уходит из чата
  socket.on("leave-chat", (chatId) => {
    if (!chatId) return;
    socket.leave(`chat:${chatId}`);
  });

  // Пользователь заходит в нексферу
  socket.on("join-nexfery", async (data) => {
    const nexferyId = data && typeof data === 'object' ? data.nexferyId : data;
    const userId = data && typeof data === 'object' ? data.userId : null;
    
    if (!nexferyId) return;
    socket.join(`nexfery:${nexferyId}`);
    
    // Если пришли данные о пользователе, отправляем системное сообщение
    if (userId) {
      try {
        const userResult = await pool.query(
          "SELECT display_name, username FROM users WHERE id = $1",
          [userId]
        );
        if (userResult.rowCount > 0) {
          const user = userResult.rows[0];
          const username = user.display_name || user.username;
          
          // Отправляем системное сообщение всем в комнате
          io.to(`nexfery:${nexferyId}`).emit("nexfery:system-message", {
            type: 'member-joined',
            text: `👋 ${username} присоединился к нексфере`,
            timestamp: new Date()
          });
        }
      } catch (err) {
        console.error("Ошибка при отправке системного сообщения:", err);
      }
    }
  });

  // Пользователь уходит из нексферы
  socket.on("leave-nexfery", async (data) => {
    const nexferyId = data && typeof data === 'object' ? data.nexferyId : data;
    const userId = data && typeof data === 'object' ? data.userId : null;
    
    if (!nexferyId) return;
    socket.leave(`nexfery:${nexferyId}`);
    
    // Если пришли данные о пользователе, отправляем системное сообщение
    if (userId) {
      try {
        const userResult = await pool.query(
          "SELECT display_name, username FROM users WHERE id = $1",
          [userId]
        );
        if (userResult.rowCount > 0) {
          const user = userResult.rows[0];
          const username = user.display_name || user.username;
          
          // Отправляем системное сообщение всем в комнате
          io.to(`nexfery:${nexferyId}`).emit("nexfery:system-message", {
            type: 'member-left',
            text: `👋 ${username} покинул нексферу`,
            timestamp: new Date()
          });
        }
      } catch (err) {
        console.error("Ошибка при отправке системного сообщения:", err);
      }
    }
  });

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
    // Найти и удалить пользователя
    for (const [userId, user] of onlineUsers.entries()) {
      if (user.socketId === socket.id) {
        onlineUsers.delete(userId);
        // Установить статус offline и время last_seen
        const lastSeenTime = new Date();
        userStatuses.set(userId, {
          status: 'offline',
          lastSeen: lastSeenTime
        });
        console.log(`User ${userId} is offline. Total online: ${onlineUsers.size}`);
        io.emit("stats-update", {
          onlineUsers: onlineUsers.size
        });
        // Форматируем время для статуса
        const timeStr = lastSeenTime.toLocaleString('ru-RU');
        io.emit("user-status-changed", {
          userId,
          status: 'offline',
          statusText: `👻 оставил цифровой след "${timeStr}"`,
          lastSeen: lastSeenTime
        });
        break;
      }
    }
  });

  // Пользователь печатает
  socket.on("user-typing", (data) => {
    const { userId, chatId } = data;
    if (userId) {
      userStatuses.set(userId, {
        status: 'typing',
        chatId,
        timestamp: new Date()
      });
      io.emit("user-status-changed", {
        userId,
        status: 'typing',
        statusText: '⌨️ стучит по клавишам'
      });
      // Автоматически вернуть в онлайн через 3 секунды если нет нового события
      setTimeout(() => {
        if (userStatuses.get(userId)?.status === 'typing') {
          userStatuses.set(userId, {
            status: 'online',
            timestamp: new Date()
          });
          io.emit("user-status-changed", {
            userId,
            status: 'online',
            statusText: '🔌 на проводе'
          });
        }
      }, 3000);
    }
  });

  // Пользователь записывает голос
  socket.on("user-recording-voice", (data) => {
    const { userId } = data;
    if (userId) {
      userStatuses.set(userId, {
        status: 'recording_voice',
        timestamp: new Date()
      });
      io.emit("user-status-changed", {
        userId,
        status: 'recording_voice',
        statusText: '🎤 оставляет свой цифровой след'
      });
    }
  });

  // Пользователь отправляет фото
  socket.on("user-sending-photo", (data) => {
    const { userId } = data;
    if (userId) {
      userStatuses.set(userId, {
        status: 'sending_photo',
        timestamp: new Date()
      });
      io.emit("user-status-changed", {
        userId,
        status: 'sending_photo',
        statusText: '📸 фото?'
      });
      setTimeout(() => {
        if (userStatuses.get(userId)?.status === 'sending_photo') {
          userStatuses.set(userId, {
            status: 'online',
            timestamp: new Date()
          });
          io.emit("user-status-changed", {
            userId,
            status: 'online',
            statusText: '🔌 на проводе'
          });
        }
      }, 2000);
    }
  });

  // Пользователь отправляет видео
  socket.on("user-sending-video", (data) => {
    const { userId } = data;
    if (userId) {
      userStatuses.set(userId, {
        status: 'sending_video',
        timestamp: new Date()
      });
      io.emit("user-status-changed", {
        userId,
        status: 'sending_video',
        statusText: '🎥 видео?'
      });
      setTimeout(() => {
        if (userStatuses.get(userId)?.status === 'sending_video') {
          userStatuses.set(userId, {
            status: 'online',
            timestamp: new Date()
          });
          io.emit("user-status-changed", {
            userId,
            status: 'online',
            statusText: '🔌 на проводе'
          });
        }
      }, 3000);
    }
  });

  // Пользователь вернулся в онлайн
  socket.on("user-back-online", (data) => {
    const { userId } = data;
    if (userId) {
      userStatuses.set(userId, {
        status: 'online',
        timestamp: new Date()
      });
      io.emit("user-status-changed", {
        userId,
        status: 'online',
        statusText: '✅ В сети'
      });
    }
  });

  // ===== ENHANCED SOCKET.IO EVENTS ДЛЯ НЕКСФЕР =====

  // Пользователь печатает в нексфере
  socket.on("nexfery:typing", (data) => {
    const { nexferyId, userId, isTyping } = data;
    if (nexferyId) {
      socket.to(`nexfery:${nexferyId}`).emit("user:typing", {
        userId,
        isTyping
      });
    }
  });

  // Online status в нексфере
  socket.on("nexfery:user-status", (data) => {
    const { nexferyId, userId, status } = data;
    if (nexferyId) {
      socket.to(`nexfery:${nexferyId}`).emit("member:status-changed", {
        userId,
        status,
        timestamp: new Date()
      });
    }
  });

  // Подтверждение прочитанного
  socket.on("message:mark-read", async (data) => {
    try {
      const { messageId, userId } = data;
      
      // Можно сохранить в БД для истории
      // await pool.query(
      //   `INSERT INTO message_read_receipts (message_id, user_id)
      //    VALUES ($1, $2)
      //    ON CONFLICT DO NOTHING`,
      //   [messageId, userId]
      // );

      socket.broadcast.emit("message:read-receipt", {
        messageId,
        userId
      });
    } catch (err) {
      console.error("Ошибка при отметке прочитанного:", err);
    }
  });
});

// Порт: локально 3000, на Render — тот, который он даёт
const PORT = process.env.PORT || 3000;

// Подключение к PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Секрет для сессий (лучше задать переменную среды SESSION_SECRET на Render)
const SESSION_SECRET =
  process.env.SESSION_SECRET || "очень_длинная_строка_для_сессий_123";

// ======= ИНИЦИАЛИЗАЦИЯ БД =======
async function initDb() {
  // 1. Пользователи
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      avatar_data TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  
  // Добавляем новые колонки если их нет (миграция)
  await pool.query(`
    ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS email TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    ADD COLUMN IF NOT EXISTS avatar_url TEXT,
    ADD COLUMN IF NOT EXISTS avatar_data TEXT,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS bio TEXT,
    ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS current_status TEXT DEFAULT 'offline';
  `).catch(() => {
    // Игнорируем ошибки если колонки уже существуют
  });

  // 2. Чаты
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chats (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // 3. Участники чатов
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (chat_id, user_id)
    );
  `);

  // 4. Сообщения — больше НЕ дропаем таблицу
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
      text TEXT,
      file_url TEXT,
      file_type TEXT,
      file_name TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Добавляем новые колонки если их нет (миграция)
  await pool.query(`
    ALTER TABLE messages 
    ADD COLUMN IF NOT EXISTS file_url TEXT,
    ADD COLUMN IF NOT EXISTS file_type TEXT,
    ADD COLUMN IF NOT EXISTS file_name TEXT,
    ADD COLUMN IF NOT EXISTS sticker_id VARCHAR(50),
    ADD COLUMN IF NOT EXISTS reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;
  `).catch(() => {
    // Игнорируем ошибки если колонки уже существуют
  });

  // Разрешаем NULL для текста (если это текстовое сообщение или файл без подписи)
  await pool.query(`
    ALTER TABLE messages ALTER COLUMN text DROP NOT NULL;
  `).catch(() => {
    // Игнорируем ошибки
  });

  // 5. Блокировки пользователей
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocked_users (
      blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (blocker_id, blocked_id)
    );
  `);

  // 6. Настройки сервера
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Инициализируем значения по умолчанию если их нет
  await pool.query(`
    INSERT INTO settings (key, value) VALUES ('site_name', 'NovaChat')
    ON CONFLICT (key) DO NOTHING;
  `);

  await pool.query(`
    INSERT INTO settings (key, value) VALUES ('max_file_size', '50')
    ON CONFLICT (key) DO NOTHING;
  `);

  // 7. Нексусы (каналы)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nexus (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      handle TEXT UNIQUE NOT NULL,
      description TEXT,
      avatar_data TEXT,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS nexus_subscribers (
      nexus_id INTEGER NOT NULL REFERENCES nexus(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'subscriber',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (nexus_id, user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS nexus_posts (
      id SERIAL PRIMARY KEY,
      nexus_id INTEGER NOT NULL REFERENCES nexus(id) ON DELETE CASCADE,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS nexus_comments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES nexus_posts(id) ON DELETE CASCADE,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // 8. Нексферы (публичные групповые чаты)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nexferies (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      handle TEXT UNIQUE NOT NULL,
      description TEXT,
      avatar_data TEXT,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_public BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS nexferies_members (
      nexfery_id INTEGER NOT NULL REFERENCES nexferies(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'member',
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (nexfery_id, user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS nexferies_messages (
      id SERIAL PRIMARY KEY,
      nexfery_id INTEGER NOT NULL REFERENCES nexferies(id) ON DELETE CASCADE,
      author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT,
      file_url TEXT,
      file_type TEXT,
      file_name TEXT,
      is_edited BOOLEAN DEFAULT FALSE,
      edited_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Таблица для приглашений в нексферы
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nexfery_invites (
      id SERIAL PRIMARY KEY,
      nexfery_id INTEGER NOT NULL REFERENCES nexferies(id) ON DELETE CASCADE,
      invited_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invited_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP + INTERVAL '7 days',
      UNIQUE(nexfery_id, invited_user_id)
    );
  `);

  // Таблица для реакций на сообщения
  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES nexferies_messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji VARCHAR(10) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(message_id, user_id, emoji)
    );
  `);

  // Таблица для отметок "прочитано"
  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_read_receipts (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES nexferies_messages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      read_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(message_id, user_id)
    );
  `);

  // Индексы для оптимизации
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_nexfery 
    ON nexferies_messages(nexfery_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_created 
    ON nexferies_messages(created_at DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_members_nexfery 
    ON nexferies_members(nexfery_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_members_user 
    ON nexferies_members(user_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_invites_user 
    ON nexfery_invites(invited_user_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_reactions_message 
    ON message_reactions(message_id);
  `);

  console.log(
    "База данных инициализирована (users, chats, chat_members, messages, blocked_users, settings, nexus, nexferies готовы)"
  );
}

initDb().catch((err) => {
  console.error("Ошибка инициализации БД:", err);
});

// Чтобы читать данные из форм
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ======= RATE LIMITERS =======
const messageLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 минута
  max: 20, // макс 20 сообщений в минуту
  message: "Слишком много сообщений, подождите",
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 100, // макс 100 запросов за 15 минут
  message: "Слишком много запросов, попробуйте позже",
  standardHeaders: true,
  legacyHeaders: false,
});

// Сессии: теперь в Postgres, а не в памяти
app.use(
  session({
    store: new pgSession({
      pool: pool,
      tableName: "session",
      createTableIfMissing: true,
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 дней
      sameSite: "lax",
      secure: false,
    },
  })
);

// ======= AUTH MIDDLEWARE =======
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, error: "Не авторизован" });
  }
  next();
}

// Ник нексуса: минимум 5 символов, обязательно латинские буквы, остальное - цифры и спец.символы
const NEXUS_HANDLE_REGEX = /^(?=.*[a-zA-Z])[a-zA-Z0-9_-]{5,30}$/;

// ======= MULTER: конфигурация для загрузки файлов =======
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "public", "uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  },
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB макс размер файла
  },
  fileFilter: (req, file, cb) => {
    // Разрешаем изображения, видео, аудио и документы
    const allowedTypes = /jpeg|jpg|png|gif|webp|mp4|mov|avi|pdf|doc|docx|txt|zip|rar|mp3|wav|ogg|m4a|webm|mpeg/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error("Неподдерживаемый тип файла"));
    }
  },
});

// ======= РОУТ ДЛЯ ЧАТА (ПРОВЕРКА ВХОДА) =======
app.get("/chat", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/login.html");
  }
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

// ======= НЕКСУСЫ (страницы) =======
app.get("/nexus", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/login.html");
  }
  res.sendFile(path.join(__dirname, "public", "nexus.html"));
});

app.get("/nexus/profile", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/login.html");
  }
  res.sendFile(path.join(__dirname, "public", "nexus-profile.html"));
});

app.get("/nexus/edit", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/login.html");
  }
  res.sendFile(path.join(__dirname, "public", "nexus-edit.html"));
});

// ======= НЕКСФЕРЫ (страница) =======
app.get("/nexferies", (req, res) => {
  if (!req.session.user) {
    return res.redirect("/login.html");
  }
  res.sendFile(path.join(__dirname, "public", "nexferies.html"));
});

// Статика
app.use(express.static(path.join(__dirname, "public")));

// ======= РЕГИСТРАЦИЯ =======
app.post("/register", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.send(
      "Логин и пароль обязательны. <a href='/register.html'>Назад</a>"
    );
  }

  try {
    const existing = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [username]
    );

    if (existing.rowCount > 0) {
      return res.send(
        "Такой логин уже занят. <a href='/register.html'>Попробовать другой</a>"
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2)",
      [username, passwordHash]
    );

    console.log("Новый пользователь зарегистрирован:", username);
    res.redirect("/login.html");
  } catch (err) {
    console.error("Ошибка при регистрации:", err);
    res.send("Ошибка сервера. Попробуйте позже.");
  }
});

// ======= ВХОД =======
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query(
      "SELECT id, username, password_hash FROM users WHERE username = $1",
      [username]
    );

    if (result.rowCount === 0) {
      return res.send(
        "Неверный логин или пароль. <a href='/login.html'>Попробовать снова</a>"
      );
    }

    const user = result.rows[0];

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.send(
        "Неверный логин или пароль. <a href='/login.html'>Попробовать снова</a>"
      );
    }

    req.session.user = { id: user.id, username: user.username };

    console.log("Пользователь вошёл:", user.username);
    res.redirect("/chat");
  } catch (err) {
    console.error("Ошибка при входе:", err);
    res.send("Ошибка сервера. Попробуйте позже.");
  }
});

// ======= /me =======
app.get("/me", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ loggedIn: false });
  }

  try {
    const result = await pool.query(
      "SELECT username, display_name, avatar_data, created_at, is_admin, bio FROM users WHERE id = $1",
      [req.session.user.id]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({ loggedIn: false });
    }

    const user = result.rows[0];
    res.json({
      loggedIn: true,
      id: req.session.user.id,
      username: user.username,
      displayName: user.display_name,
      avatarUrl: user.avatar_data,
      registeredAt: user.created_at,
      isAdmin: user.is_admin || false,
      bio: user.bio || "",
    });
  } catch (err) {
    console.error("Ошибка при получении информации пользователя:", err);
    res.status(500).json({ loggedIn: false, error: "Ошибка сервера" });
  }
});

// ======= ОБНОВЛЕНИЕ ПРОФИЛЯ =======
app.post("/update-profile", upload.single("avatar"), async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, error: "Не авторизирован" });
  }

  try {
    const { displayName, username } = req.body;
    const userId = req.session.user.id;
    const oldUsername = req.session.user.username;
    let avatarData = null;

    // Проверяем уникальность нового ника если он изменился
    if (username && username !== oldUsername) {
      const existingUser = await pool.query(
        "SELECT id FROM users WHERE username = $1",
        [username]
      );
      
      if (existingUser.rowCount > 0) {
        return res.status(400).json({ ok: false, error: "Этот ник уже занят" });
      }

      // Валидация ника
      if (username.length < 3) {
        return res.status(400).json({ ok: false, error: "Ник должен быть минимум 3 символа" });
      }
      if (username.length > 30) {
        return res.status(400).json({ ok: false, error: "Ник не должен быть больше 30 символов" });
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
        return res.status(400).json({ ok: false, error: "Ник может содержать только буквы, цифры, _ и -" });
      }
    }

    // Если загружен новый аватар - кодируем в Base64
    if (req.file) {
      const fileBuffer = fs.readFileSync(req.file.path);
      const base64Data = fileBuffer.toString('base64');
      const mimeType = req.file.mimetype;
      avatarData = `data:${mimeType};base64,${base64Data}`;
      
      // Удаляем временный файл
      fs.unlinkSync(req.file.path);
    }

    // Получаем bio из request body
    const bio = req.body.bio || null;

    // Обновляем профиль
    let query, params;
    if (avatarData && username && username !== oldUsername) {
      query = "UPDATE users SET username = $1, display_name = $2, avatar_data = $3, bio = $4 WHERE id = $5 RETURNING username, display_name, avatar_data, bio";
      params = [username, displayName || null, avatarData, bio, userId];
    } else if (avatarData) {
      query = "UPDATE users SET display_name = $1, avatar_data = $2, bio = $3 WHERE id = $4 RETURNING username, display_name, avatar_data, bio";
      params = [displayName || null, avatarData, bio, userId];
    } else if (username && username !== oldUsername) {
      query = "UPDATE users SET username = $1, display_name = $2, bio = $3 WHERE id = $4 RETURNING username, display_name, avatar_data, bio";
      params = [username, displayName || null, bio, userId];
    } else {
      query = "UPDATE users SET display_name = $1, bio = $2 WHERE id = $3 RETURNING username, display_name, avatar_data, bio";
      params = [displayName || null, bio, userId];
    }

    const result = await pool.query(query, params);
    const updatedUser = result.rows[0];

    // Обновляем сессию
    req.session.user.username = updatedUser.username;

    // Отправляем обновление профиля всем подключенным пользователям через Socket.IO
    io.emit("user-profile-updated", {
      userId: userId,
      username: updatedUser.username,
      displayName: updatedUser.display_name,
      avatarUrl: updatedUser.avatar_data,
      bio: updatedUser.bio,
    });

    res.json({
      ok: true,
      username: updatedUser.username,
      displayName: updatedUser.display_name,
      avatarUrl: updatedUser.avatar_data,
      bio: updatedUser.bio,
    });
  } catch (err) {
    console.error("Ошибка при обновлении профиля:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ======= ПОЛУЧИТЬ ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ =======
app.get("/api/user/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    
    const result = await pool.query(
      "SELECT id, username, display_name, avatar_data, bio, created_at FROM users WHERE id = $1",
      [userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Пользователь не найден" });
    }
    
    const user = result.rows[0];
    res.json({
      ok: true,
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      avatarUrl: user.avatar_data,
      bio: user.bio || "",
      registeredAt: user.created_at,
    });
  } catch (err) {
    console.error("Ошибка при получении профиля:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ======= ПОИСК ПОЛЬЗОВАТЕЛЕЙ =======
app.get("/api/users", async (req, res) => {
  try {
    const search = req.query.search || "";
    const searchLower = search.toLowerCase().trim();
    
    if (searchLower.length === 0) {
      return res.json({ users: [] });
    }

    const result = await pool.query(
      `
        SELECT id, username, display_name, avatar_data
        FROM users
        WHERE 
          username ILIKE $1 
          OR display_name ILIKE $1
        LIMIT 20
      `,
      [`%${searchLower}%`]
    );

    res.json({ users: result.rows });
  } catch (err) {
    console.error("Ошибка при поиске пользователей:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ======= НЕКСУСЫ (API) =======
app.post("/api/nexus", requireAuth, upload.single("avatar"), async (req, res) => {
  try {
    const userId = req.session.user.id;
    const title = (req.body.title || "").trim();
    const rawHandle = (req.body.handle || "").trim().toLowerCase();
    const description = (req.body.description || "").trim();

    if (title.length < 3 || title.length > 60) {
      return res.status(400).json({ ok: false, error: "Название должно быть от 3 до 60 символов" });
    }

    if (!NEXUS_HANDLE_REGEX.test(rawHandle)) {
      return res.status(400).json({ ok: false, error: "Ник должен быть 5-30 символов, содержать минимум одну латинскую букву (a-z или A-Z), остальное - цифры, подчеркивание или дефис" });
    }

    const existingHandle = await pool.query(
      "SELECT id FROM nexus WHERE handle = $1",
      [rawHandle]
    );
    if (existingHandle.rowCount > 0) {
      return res.status(400).json({ ok: false, error: "Такой ник нексуса уже занят" });
    }

    let avatarData = null;
    if (req.file) {
      const fileBuffer = fs.readFileSync(req.file.path);
      const base64Data = fileBuffer.toString("base64");
      const mimeType = req.file.mimetype;
      avatarData = `data:${mimeType};base64,${base64Data}`;
      fs.unlinkSync(req.file.path);
    }

    const result = await pool.query(
      `
        INSERT INTO nexus (title, handle, description, avatar_data, author_id)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, title, handle, description, avatar_data, author_id, created_at
      `,
      [title, rawHandle, description || null, avatarData, userId]
    );

    const nexus = result.rows[0];

    await pool.query(
      "INSERT INTO nexus_subscribers (nexus_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING",
      [nexus.id, userId]
    );

    // Уведомляем всех клиентов об обновлении нексоленты
    io.emit("nexus:updated");

    res.json({ ok: true, nexus });
  } catch (err) {
    console.error("Ошибка при создании нексуса:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

app.get("/api/nexus", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    
    // Получаем нексусы
    const nexusResult = await pool.query(
      `
        SELECT
          n.id,
          n.title,
          n.handle,
          n.description,
          n.avatar_data,
          n.author_id,
          n.created_at,
          u.username AS author_username,
          u.display_name AS author_display_name,
          COALESCE(subs.subscribers_count, 0) AS subscribers_count,
          COALESCE(posts.posts_count, 0) AS posts_count,
          ns_me.role AS my_role
        FROM nexus n
        JOIN users u ON u.id = n.author_id
        LEFT JOIN (
          SELECT nexus_id, COUNT(*)::int AS subscribers_count
          FROM nexus_subscribers
          GROUP BY nexus_id
        ) subs ON subs.nexus_id = n.id
        LEFT JOIN (
          SELECT nexus_id, COUNT(*)::int AS posts_count
          FROM nexus_posts
          GROUP BY nexus_id
        ) posts ON posts.nexus_id = n.id
        LEFT JOIN nexus_subscribers ns_me ON ns_me.nexus_id = n.id AND ns_me.user_id = $1
        WHERE n.author_id = $2 OR ns_me.user_id = $3
        ORDER BY n.created_at DESC
      `,
      [userId, userId, userId]
    );

    // Получаем нексферы пользователя
    const nexferiesResult = await pool.query(
      `
      SELECT 
        n.id, n.title, n.handle, n.description, n.avatar_data, n.author_id, n.created_at,
        u.username as author_username, u.display_name as author_display_name,
        (SELECT COUNT(*) FROM nexferies_members WHERE nexfery_id = n.id) as members_count,
        (SELECT COUNT(*) FROM nexferies_messages WHERE nexfery_id = n.id) as messages_count
      FROM nexferies n
      JOIN nexferies_members nm ON n.id = nm.nexfery_id
      JOIN users u ON n.author_id = u.id
      WHERE nm.user_id = $1
      ORDER BY n.created_at DESC
      `,
      [userId]
    );

    // Преобразуем нексусы
    const nexus = nexusResult.rows.map(row => ({
      ...row,
      type: 'nexus'
    }));

    // Преобразуем нексферы
    const nexferies = nexferiesResult.rows.map(row => ({
      id: row.id,
      title: row.title,
      handle: row.handle,
      description: row.description,
      avatar_data: row.avatar_data,
      author_id: row.author_id,
      created_at: row.created_at,
      author_username: row.author_username,
      author_display_name: row.author_display_name,
      subscribers_count: parseInt(row.members_count), // Используем members_count как subscribers
      posts_count: parseInt(row.messages_count), // Используем messages_count как posts
      my_role: 'member', // У пользователя есть роль в нексфере по умолчанию
      type: 'nexfery'
    }));

    // Объединяем и сортируем по дате
    const combined = [...nexus, ...nexferies].sort((a, b) => {
      return new Date(b.created_at) - new Date(a.created_at);
    });

    res.json({ ok: true, nexus: combined });
  } catch (err) {
    console.error("Ошибка при получении списка нексусов:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// Глобальный поиск всех нексусов
app.get("/api/nexus/search/all", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const search = req.query.q || '';
    const searchTerm = `%${search}%`;

    const result = await pool.query(
      `
        SELECT
          n.id,
          n.title,
          n.handle,
          n.description,
          n.avatar_data,
          n.author_id,
          n.created_at,
          u.username AS author_username,
          u.display_name AS author_display_name,
          COALESCE(subs.subscribers_count, 0) AS subscribers_count,
          COALESCE(posts.posts_count, 0) AS posts_count,
          ns_me.role AS my_role
        FROM nexus n
        JOIN users u ON u.id = n.author_id
        LEFT JOIN (
          SELECT nexus_id, COUNT(*)::int AS subscribers_count
          FROM nexus_subscribers
          GROUP BY nexus_id
        ) subs ON subs.nexus_id = n.id
        LEFT JOIN (
          SELECT nexus_id, COUNT(*)::int AS posts_count
          FROM nexus_posts
          GROUP BY nexus_id
        ) posts ON posts.nexus_id = n.id
        LEFT JOIN nexus_subscribers ns_me ON ns_me.nexus_id = n.id AND ns_me.user_id = $1
        WHERE n.title ILIKE $2 OR n.handle ILIKE $2 OR n.description ILIKE $2
        ORDER BY n.created_at DESC
      `,
      [userId, searchTerm]
    );

    res.json({ ok: true, nexus: result.rows });
  } catch (err) {
    console.error("Ошибка при поиске нексусов:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

app.get("/api/nexus/:nexusId", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const nexusId = parseInt(req.params.nexusId, 10);

    const result = await pool.query(
      `
        SELECT
          n.id,
          n.title,
          n.handle,
          n.description,
          n.avatar_data,
          n.author_id,
          n.created_at,
          u.username AS author_username,
          u.display_name AS author_display_name,
          COALESCE(subs.subscribers_count, 0) AS subscribers_count,
          COALESCE(posts.posts_count, 0) AS posts_count,
          ns_me.role AS my_role
        FROM nexus n
        JOIN users u ON u.id = n.author_id
        LEFT JOIN (
          SELECT nexus_id, COUNT(*)::int AS subscribers_count
          FROM nexus_subscribers
          GROUP BY nexus_id
        ) subs ON subs.nexus_id = n.id
        LEFT JOIN (
          SELECT nexus_id, COUNT(*)::int AS posts_count
          FROM nexus_posts
          GROUP BY nexus_id
        ) posts ON posts.nexus_id = n.id
        LEFT JOIN nexus_subscribers ns_me ON ns_me.nexus_id = n.id AND ns_me.user_id = $1
        WHERE n.id = $2
        LIMIT 1
      `,
      [userId, nexusId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Нексус не найден" });
    }

    res.json({ ok: true, nexus: result.rows[0] });
  } catch (err) {
    console.error("Ошибка при получении нексуса:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

app.post("/api/nexus/:nexusId/subscribe", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const nexusId = parseInt(req.params.nexusId, 10);

    await pool.query(
      "INSERT INTO nexus_subscribers (nexus_id, user_id, role) VALUES ($1, $2, 'subscriber') ON CONFLICT DO NOTHING",
      [nexusId, userId]
    );

    // Уведомляем всех клиентов об обновлении нексоленты
    io.emit("nexus:updated");

    res.json({ ok: true });
  } catch (err) {
    console.error("Ошибка при подписке на нексус:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

app.post("/api/nexus/:nexusId/unsubscribe", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const nexusId = parseInt(req.params.nexusId, 10);

    const roleResult = await pool.query(
      "SELECT role FROM nexus_subscribers WHERE nexus_id = $1 AND user_id = $2",
      [nexusId, userId]
    );

    if (roleResult.rowCount > 0 && roleResult.rows[0].role === "owner") {
      return res.status(400).json({ ok: false, error: "Владелец не может отписаться" });
    }

    await pool.query(
      "DELETE FROM nexus_subscribers WHERE nexus_id = $1 AND user_id = $2",
      [nexusId, userId]
    );

    // Уведомляем всех клиентов об обновлении нексоленты
    io.emit("nexus:updated");

    res.json({ ok: true });
  } catch (err) {
    console.error("Ошибка при отписке от нексуса:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

app.get("/api/nexus/:nexusId/posts", requireAuth, async (req, res) => {
  try {
    const nexusId = parseInt(req.params.nexusId, 10);
    const result = await pool.query(
      `
        SELECT
          p.id,
          p.text,
          p.created_at,
          u.username AS author_username,
          u.display_name AS author_display_name,
          COALESCE(c.comments_count, 0) AS comments_count
        FROM nexus_posts p
        JOIN users u ON u.id = p.author_id
        LEFT JOIN (
          SELECT post_id, COUNT(*)::int AS comments_count
          FROM nexus_comments
          GROUP BY post_id
        ) c ON c.post_id = p.id
        WHERE p.nexus_id = $1
        ORDER BY p.created_at DESC
      `,
      [nexusId]
    );

    res.json({ ok: true, posts: result.rows });
  } catch (err) {
    console.error("Ошибка при получении постов нексуса:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

app.post("/api/nexus/:nexusId/posts", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const nexusId = parseInt(req.params.nexusId, 10);
    const text = (req.body.text || "").trim();

    if (!text || text.length > 5000) {
      return res.status(400).json({ ok: false, error: "Текст поста должен быть от 1 до 5000 символов" });
    }

    const ownerResult = await pool.query(
      "SELECT author_id FROM nexus WHERE id = $1",
      [nexusId]
    );

    if (ownerResult.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Нексус не найден" });
    }

    if (ownerResult.rows[0].author_id !== userId) {
      return res.status(403).json({ ok: false, error: "Только владелец может публиковать посты" });
    }

    const result = await pool.query(
      `
        INSERT INTO nexus_posts (nexus_id, author_id, text)
        VALUES ($1, $2, $3)
        RETURNING id, text, created_at, author_id
      `,
      [nexusId, userId, text]
    );

    const post = result.rows[0];

    // Получить информацию об авторе для трансляции
    const authorResult = await pool.query(
      "SELECT username, display_name FROM users WHERE id = $1",
      [userId]
    );
    const author = authorResult.rows[0] || { username: "Unknown", display_name: "Unknown" };

    // Транслировать новый пост всем подписчикам в реальном времени
    io.emit("nexus-post-new", {
      nexusId,
      post: {
        id: post.id,
        text: post.text,
        created_at: post.created_at,
        author_id: post.author_id,
        author_username: author.username,
        author_display_name: author.display_name,
        comments_count: 0
      }
    });

    res.json({ ok: true, post });
  } catch (err) {
    console.error("Ошибка при создании поста нексуса:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

app.get("/api/nexus/posts/:postId/comments", requireAuth, async (req, res) => {
  try {
    const postId = parseInt(req.params.postId, 10);
    const result = await pool.query(
      `
        SELECT
          c.id,
          c.text,
          c.created_at,
          u.username AS author_username,
          u.display_name AS author_display_name
        FROM nexus_comments c
        JOIN users u ON u.id = c.author_id
        WHERE c.post_id = $1
        ORDER BY c.created_at ASC
      `,
      [postId]
    );

    res.json({ ok: true, comments: result.rows });
  } catch (err) {
    console.error("Ошибка при получении комментариев:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

app.post("/api/nexus/posts/:postId/comments", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const postId = parseInt(req.params.postId, 10);
    const text = (req.body.text || "").trim();

    if (!text || text.length > 2000) {
      return res.status(400).json({ ok: false, error: "Комментарий должен быть от 1 до 2000 символов" });
    }

    const postResult = await pool.query(
      "SELECT nexus_id FROM nexus_posts WHERE id = $1",
      [postId]
    );

    if (postResult.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Пост не найден" });
    }

    const nexusId = postResult.rows[0].nexus_id;
    const subResult = await pool.query(
      "SELECT role FROM nexus_subscribers WHERE nexus_id = $1 AND user_id = $2",
      [nexusId, userId]
    );

    if (subResult.rowCount === 0) {
      return res.status(403).json({ ok: false, error: "Комментарии доступны только подписчикам" });
    }

    const result = await pool.query(
      `
        INSERT INTO nexus_comments (post_id, author_id, text)
        VALUES ($1, $2, $3)
        RETURNING id, text, created_at
      `,
      [postId, userId, text]
    );

    res.json({ ok: true, comment: result.rows[0] });
  } catch (err) {
    console.error("Ошибка при создании комментария:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ======= УПРАВЛЕНИЕ ПРОФИЛЕМ НЕКСУСА =======
app.get("/api/nexus/:nexusId/subscribers", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const nexusId = parseInt(req.params.nexusId, 10);

    // Проверяем, что пользователь владелец нексуса
    const ownerCheck = await pool.query(
      "SELECT author_id FROM nexus WHERE id = $1",
      [nexusId]
    );

    if (ownerCheck.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Нексус не найден" });
    }

    if (ownerCheck.rows[0].author_id !== userId) {
      return res.status(403).json({ ok: false, error: "Только владелец может управлять подписчиками" });
    }

    // Получаем всех подписчиков
    const result = await pool.query(
      `
        SELECT
          ns.user_id,
          u.username,
          u.display_name,
          u.avatar_data,
          ns.role,
          ns.created_at
        FROM nexus_subscribers ns
        JOIN users u ON u.id = ns.user_id
        WHERE ns.nexus_id = $1
        ORDER BY ns.created_at DESC
      `,
      [nexusId]
    );

    res.json({ ok: true, subscribers: result.rows });
  } catch (err) {
    console.error("Ошибка при получении подписчиков:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

app.delete("/api/nexus/:nexusId/subscribers/:userId", requireAuth, async (req, res) => {
  try {
    const ownerId = req.session.user.id;
    const nexusId = parseInt(req.params.nexusId, 10);
    const subscriberId = parseInt(req.params.userId, 10);

    // Проверяем, что пользователь владелец нексуса
    const ownerCheck = await pool.query(
      "SELECT author_id FROM nexus WHERE id = $1",
      [nexusId]
    );

    if (ownerCheck.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Нексус не найден" });
    }

    if (ownerCheck.rows[0].author_id !== ownerId) {
      return res.status(403).json({ ok: false, error: "Только владелец может удалять подписчиков" });
    }

    // Проверяем, что это не сам владелец
    if (subscriberId === ownerId) {
      return res.status(400).json({ ok: false, error: "Владелец не может удалить себя" });
    }

    await pool.query(
      "DELETE FROM nexus_subscribers WHERE nexus_id = $1 AND user_id = $2",
      [nexusId, subscriberId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Ошибка при удалении подписчика:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

app.patch("/api/nexus/:nexusId", requireAuth, upload.single("avatar"), async (req, res) => {
  try {
    const userId = req.session.user.id;
    const nexusId = parseInt(req.params.nexusId, 10);
    const title = (req.body.title || "").trim();
    const rawHandle = (req.body.handle || "").trim().toLowerCase();
    const description = (req.body.description || "").trim();

    // Проверяем, что пользователь владелец нексуса
    const ownerCheck = await pool.query(
      "SELECT author_id FROM nexus WHERE id = $1",
      [nexusId]
    );

    if (ownerCheck.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Нексус не найден" });
    }

    if (ownerCheck.rows[0].author_id !== userId) {
      return res.status(403).json({ ok: false, error: "Только владелец может редактировать нексус" });
    }

    // Валидируем длину названия
    if (title && (title.length < 3 || title.length > 60)) {
      return res.status(400).json({ ok: false, error: "Название должно быть от 3 до 60 символов" });
    }

    // Проверяем ник, если изменяется
    if (rawHandle && !NEXUS_HANDLE_REGEX.test(rawHandle)) {
      return res.status(400).json({ ok: false, error: "Ник должен быть 5-30 символов, содержать минимум одну латинскую букву" });
    }

    // Проверяем уникальность нового ника
    if (rawHandle) {
      const existingHandle = await pool.query(
        "SELECT id FROM nexus WHERE handle = $1 AND id != $2",
        [rawHandle, nexusId]
      );
      if (existingHandle.rowCount > 0) {
        return res.status(400).json({ ok: false, error: "Такой ник нексуса уже занят" });
      }
    }

    let avatarData = null;
    let updateFields = [];
    let updateValues = [];
    let paramIndex = 1;

    if (title) {
      updateFields.push(`title = $${paramIndex++}`);
      updateValues.push(title);
    }

    if (rawHandle) {
      updateFields.push(`handle = $${paramIndex++}`);
      updateValues.push(rawHandle);
    }

    if (description || description === "") {
      updateFields.push(`description = $${paramIndex++}`);
      updateValues.push(description || null);
    }

    if (req.file) {
      const fileBuffer = fs.readFileSync(req.file.path);
      const base64Data = fileBuffer.toString("base64");
      const mimeType = req.file.mimetype;
      avatarData = `data:${mimeType};base64,${base64Data}`;
      fs.unlinkSync(req.file.path);
      updateFields.push(`avatar_data = $${paramIndex++}`);
      updateValues.push(avatarData);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ ok: false, error: "Не передано ни одного поля для обновления" });
    }

    updateValues.push(nexusId);

    const query = `
      UPDATE nexus
      SET ${updateFields.join(", ")}
      WHERE id = $${paramIndex}
      RETURNING id, title, handle, description, avatar_data, author_id, created_at
    `;

    const result = await pool.query(query, updateValues);

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Нексус не найден" });
    }

    res.json({ ok: true, nexus: result.rows[0] });
  } catch (err) {
    console.error("Ошибка при обновлении нексуса:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ======= СПИСОК ЛИЧНЫХ ЧАТОВ =======
app.get("/chats/list", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, error: "Не авторизован" });
  }

  const userId = req.session.user.id;

  try {
    const result = await pool.query(
      `
      SELECT
        c.id,
        c.created_at,
        u.id AS peer_user_id,
        u.username AS peer_username,
        u.display_name AS peer_display_name,
        u.avatar_data AS peer_avatar_url
      FROM chats c
      JOIN chat_members cm_self
        ON cm_self.chat_id = c.id
      JOIN chat_members cm_peer
        ON cm_peer.chat_id = c.id AND cm_peer.user_id <> cm_self.user_id
      JOIN users u
        ON u.id = cm_peer.user_id
      WHERE cm_self.user_id = $1
      ORDER BY c.created_at DESC;
      `,
      [userId]
    );

    res.json({ ok: true, chats: result.rows });
  } catch (err) {
    console.error("Ошибка при получении списка чатов:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ======= СОЗДАНИЕ ЛИЧНОГО ЧАТА =======
app.post("/chats/new", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, error: "Не авторизован" });
  }

  const myId = req.session.user.id;
  const { username } = req.body;

  if (!username) {
    return res
      .status(400)
      .json({ ok: false, error: "Укажите логин пользователя" });
  }

  try {
    // логин текущего пользователя
    const selfUser = await pool.query(
      "SELECT username FROM users WHERE id = $1",
      [myId]
    );

    if (selfUser.rowCount > 0 && selfUser.rows[0].username === username) {
      return res
        .status(400)
        .json({ ok: false, error: "Нельзя создать чат с самим собой" });
    }

    // другой пользователь
    const other = await pool.query(
      "SELECT id, username FROM users WHERE username = $1",
      [username]
    );

    if (other.rowCount === 0) {
      return res
        .status(404)
        .json({ ok: false, error: "Пользователь не найден" });
    }

    const otherId = other.rows[0].id;

    // есть ли уже чат между ними
    const existing = await pool.query(
      `
      SELECT c.id
      FROM chats c
      JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = $1
      JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = $2
      LIMIT 1;
      `,
      [myId, otherId]
    );

    if (existing.rowCount > 0) {
      return res.json({
        ok: true,
        existing: true,
        chatId: existing.rows[0].id,
        peerUsername: other.rows[0].username,
      });
    }

    // создаём новый чат
    const chatInsert = await pool.query(
      "INSERT INTO chats DEFAULT VALUES RETURNING id, created_at"
    );
    const chatId = chatInsert.rows[0].id;

    await pool.query(
      `
      INSERT INTO chat_members (chat_id, user_id)
      VALUES ($1, $2), ($1, $3);
      `,
      [chatId, myId, otherId]
    );
    
     // 🔥 говорим всем подключённым клиентам: список чатов изменился
    io.emit("chats:updated");

    res.json({
      ok: true,
      existing: false,
      chatId,
      peerUsername: other.rows[0].username,
    });
  } catch (err) {
    console.error("Ошибка при создании чата:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ======= ПОЛУЧИТЬ ИЛИ СОЗДАТЬ ЧАТ (по userId) =======
app.post("/chats/get-or-create", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, error: "Не авторизован" });
  }

  const myId = req.session.user.id;
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ ok: false, error: "Укажите ID пользователя" });
  }

  if (myId === parseInt(userId)) {
    return res.status(400).json({ ok: false, error: "Нельзя создать чат с самим собой" });
  }

  try {
    // Проверяем существование пользователя
    const userCheck = await pool.query(
      "SELECT id, username FROM users WHERE id = $1",
      [userId]
    );

    if (userCheck.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Пользователь не найден" });
    }

    // Проверяем наличие существующего чата
    const existing = await pool.query(
      `
      SELECT c.id
      FROM chats c
      JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = $1
      JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = $2
      LIMIT 1;
      `,
      [myId, userId]
    );

    if (existing.rowCount > 0) {
      return res.json({
        ok: true,
        chatId: existing.rows[0].id,
      });
    }

    // Создаем новый чат
    const chatInsert = await pool.query(
      "INSERT INTO chats DEFAULT VALUES RETURNING id, created_at"
    );
    const chatId = chatInsert.rows[0].id;

    await pool.query(
      `
      INSERT INTO chat_members (chat_id, user_id)
      VALUES ($1, $2), ($1, $3);
      `,
      [chatId, myId, userId]
    );

    // 🔥 Уведомляем все клиенты об изменении списка чатов
    io.emit("chats:updated");

    res.json({
      ok: true,
      chatId,
    });
  } catch (err) {
    console.error("Ошибка при получении/создании чата:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ======= ПОЛУЧЕНИЕ СООБЩЕНИЙ ЧАТА =======
app.get("/chats/:chatId/messages", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, error: "Не авторизован" });
  }

  const userId = req.session.user.id;
  const chatId = parseInt(req.params.chatId, 10);

  if (!chatId || Number.isNaN(chatId)) {
    return res.status(400).json({ ok: false, error: "Некорректный chatId" });
  }

  try {
    const memberCheck = await pool.query(
      "SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 LIMIT 1;",
      [chatId, userId]
    );

    if (memberCheck.rowCount === 0) {
      return res
        .status(403)
        .json({ ok: false, error: "У вас нет доступа к этому чату" });
    }

    const result = await pool.query(
      `
      SELECT
        m.id,
        u.username AS author,
        m.text,
        m.file_url,
        m.file_type,
        m.file_name,
        m.sticker_id,
        m.reply_to_id,
        to_char(m.created_at, 'HH24:MI') AS time
      FROM messages m
      JOIN users u ON u.id = m.author_id
      WHERE m.chat_id = $1
      ORDER BY m.created_at ASC
      LIMIT 200;
      `,
      [chatId]
    );

    res.json({ ok: true, messages: result.rows });
  } catch (err) {
    console.error("Ошибка при получении сообщений:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ======= ОТПРАВКА СООБЩЕНИЯ В ЧАТ =======
app.post("/chats/:chatId/messages", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, error: "Не авторизован" });
  }

  const userId = req.session.user.id;
  const chatId = parseInt(req.params.chatId, 10);
  const { text, sticker, replyToId } = req.body;

  if (!chatId || Number.isNaN(chatId)) {
    return res.status(400).json({ ok: false, error: "Некорректный chatId" });
  }

  // Проверяем, что либо текст, либо стикер
  if ((!text || !text.trim()) && !sticker) {
    return res
      .status(400)
      .json({ ok: false, error: "Текст сообщения или стикер не могут быть пустыми" });
  }

  try {
    // Проверяем, что пользователь участник чата
    const memberCheck = await pool.query(
      "SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 LIMIT 1;",
      [chatId, userId]
    );

    if (memberCheck.rowCount === 0) {
      return res
        .status(403)
        .json({ ok: false, error: "У вас нет доступа к этому чату" });
    }

    // Сохраняем сообщение в БД
    const insertResult = await pool.query(
      `
      INSERT INTO messages (chat_id, author_id, text, sticker_id, reply_to_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, text, sticker_id, reply_to_id, created_at;
      `,
      [chatId, userId, text ? text.trim() : "", sticker || null, replyToId || null]
    );

    const row = insertResult.rows[0];

    // Узнаём логин автора
    const userResult = await pool.query(
      "SELECT username FROM users WHERE id = $1;",
      [userId]
    );
    const authorUsername =
      userResult.rowCount > 0 ? userResult.rows[0].username : "Unknown";

    // Объект сообщения, который пойдёт по сокету
    const msg = {
      id: row.id,
      chatId,                  // очень важно передавать chatId
      author: authorUsername,
      text: row.text,
      sticker: row.sticker_id,
      reply_to_id: row.reply_to_id,
      time: new Date(row.created_at).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };

    // 🔥 Отправляем сообщение всем в комнате этого чата
    io.to(`chat:${chatId}`).emit("chat:new-message", msg);

    // Клиенту достаточно "ok"
    return res.json({ ok: true });
  } catch (err) {
    console.error("Ошибка при отправке сообщения:", err);
    return res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ======= ЗАГРУЗКА ФАЙЛА В ЧАТ =======
app.post("/chats/:chatId/upload", upload.single("file"), async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, error: "Не авторизован" });
  }

  const userId = req.session.user.id;
  const chatId = parseInt(req.params.chatId, 10);

  if (!chatId || Number.isNaN(chatId)) {
    return res.status(400).json({ ok: false, error: "Некорректный chatId" });
  }

  if (!req.file) {
    return res.status(400).json({ ok: false, error: "Файл не загружен" });
  }

  try {
    // Проверяем, что пользователь участник чата
    const memberCheck = await pool.query(
      "SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 LIMIT 1;",
      [chatId, userId]
    );

    if (memberCheck.rowCount === 0) {
      return res
        .status(403)
        .json({ ok: false, error: "У вас нет доступа к этому чату" });
    }

    // Определяем тип файла
    const fileType = req.file.mimetype.split("/")[0]; // image, video, application, etc
    const fileUrl = `/uploads/${req.file.filename}`;
    const fileName = req.file.originalname;
    const caption = req.body.caption || ""; // Опциональная подпись к файлу

    // Сохраняем сообщение с файлом в БД
    const insertResult = await pool.query(
      `
      INSERT INTO messages (chat_id, author_id, text, file_url, file_type, file_name)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, created_at;
      `,
      [chatId, userId, caption, fileUrl, fileType, fileName]
    );

    const row = insertResult.rows[0];

    // Узнаём логин автора
    const userResult = await pool.query(
      "SELECT username FROM users WHERE id = $1;",
      [userId]
    );
    const authorUsername =
      userResult.rowCount > 0 ? userResult.rows[0].username : "Unknown";

    // Объект сообщения, который пойдёт по сокету
    const msg = {
      id: row.id,
      chatId,
      author: authorUsername,
      text: caption,
      fileUrl: fileUrl,
      fileType: fileType,
      fileName: fileName,
      time: new Date(row.created_at).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };

    // 🔥 Отправляем сообщение всем в комнате этого чата
    io.to(`chat:${chatId}`).emit("chat:new-message", msg);

    return res.json({ ok: true, message: msg });
  } catch (err) {
    console.error("Ошибка при загрузке файла:", err);
    return res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ======= УДАЛЕНИЕ СООБЩЕНИЯ ИЗ ЧАТА =======
app.delete("/chats/:chatId/messages/:messageId", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, error: "Не авторизован" });
  }

  const userId = req.session.user.id;
  const chatId = parseInt(req.params.chatId, 10);
  const messageId = parseInt(req.params.messageId, 10);

  if (!chatId || Number.isNaN(chatId) || !messageId || Number.isNaN(messageId)) {
    return res.status(400).json({ ok: false, error: "Некорректные id" });
  }

  try {
    // проверяем, что пользователь участник чата
    const memberCheck = await pool.query(
      "SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 LIMIT 1;",
      [chatId, userId]
    );

    if (memberCheck.rowCount === 0) {
      return res
        .status(403)
        .json({ ok: false, error: "У вас нет доступа к этому чату" });
    }

    // удаляем только СВОЁ сообщение
    const deleteResult = await pool.query(
      `
      DELETE FROM messages
      WHERE id = $1 AND chat_id = $2 AND author_id = $3
      RETURNING id;
      `,
      [messageId, chatId, userId]
    );

    if (deleteResult.rowCount === 0) {
      return res.status(403).json({
        ok: false,
        error: "Вы можете удалять только свои сообщения",
      });
    }

    // 🔥 уведомляем всех участников этого чата
    io.to(`chat:${chatId}`).emit("chat:delete-message", {
      id: messageId,
      chatId,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("Ошибка при удалении сообщения:", err);
    return res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ======= РЕДАКТИРОВАНИЕ СООБЩЕНИЯ =======
app.patch("/chats/:chatId/messages/:messageId", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, error: "Не авторизован" });
  }

  const userId = req.session.user.id;
  const chatId = parseInt(req.params.chatId, 10);
  const messageId = parseInt(req.params.messageId, 10);
  const { text } = req.body;

  if (!chatId || Number.isNaN(chatId) || !messageId || Number.isNaN(messageId)) {
    return res.status(400).json({ ok: false, error: "Некорректные параметры" });
  }

  if (!text || !text.trim()) {
    return res.status(400).json({ ok: false, error: "Текст сообщения не может быть пустым" });
  }

  try {
    const memberCheck = await pool.query(
      "SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 LIMIT 1;",
      [chatId, userId]
    );

    if (memberCheck.rowCount === 0) {
      return res
        .status(403)
        .json({ ok: false, error: "У вас нет доступа к этому чату" });
    }

    const updateResult = await pool.query(
      `
      UPDATE messages
      SET text = $1
      WHERE id = $2 AND chat_id = $3 AND author_id = $4
      RETURNING id, text;
      `,
      [text.trim(), messageId, chatId, userId]
    );

    if (updateResult.rowCount === 0) {
      return res.status(403).json({ ok: false, error: "Нельзя изменить это сообщение" });
    }

    const row = updateResult.rows[0];
    io.to(`chat:${chatId}`).emit("chat:edit-message", {
      id: row.id,
      chatId,
      text: row.text,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("Ошибка при редактировании сообщения:", err);
    return res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ======= УДАЛЕНИЕ ЧАТА =======
app.delete("/chats/:chatId", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, error: "Не авторизован" });
  }

  const userId = req.session.user.id;
  const chatId = parseInt(req.params.chatId, 10);

  if (!chatId || Number.isNaN(chatId)) {
    return res.status(400).json({ ok: false, error: "Некорректный chatId" });
  }

  try {
    // Проверяем, что пользователь вообще участник этого чата
    const memberCheck = await pool.query(
      "SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 LIMIT 1;",
      [chatId, userId]
    );

    if (memberCheck.rowCount === 0) {
      return res
        .status(403)
        .json({ ok: false, error: "У вас нет доступа к этому чату" });
    }

    // Удаляем чат — сообщения и участники уйдут каскадом
    await pool.query("DELETE FROM chats WHERE id = $1;", [chatId]);

    // 🔥 Сообщаем всем клиентам, что список чатов обновился
    io.emit("chats:updated");

    return res.json({ ok: true });
  } catch (err) {
    console.error("Ошибка при удалении чата:", err);
    return res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ======= ВЫХОД И УДАЛЕНИЕ АККАУНТА =======
app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login.html");
  });
});

app.post("/delete-account", async (req, res) => {
  if (!req.session.user) {
    return res.redirect("/login.html");
  }

  try {
    await pool.query("DELETE FROM users WHERE id = $1", [req.session.user.id]);
    req.session.destroy(() => {
      res.redirect("/register.html");
    });
  } catch (err) {
    console.error(err);
    res.send("Ошибка при удалении аккаунта");
  }
});

// ======= НЕКСФЕРЫ (публичные групповые чаты) =======

// Создать новую нексферу
app.post("/api/nexferies", requireAuth, upload.single("avatar"), async (req, res) => {
  try {
    const userId = req.session.user.id;
    const title = (req.body.title || "").trim();
    const rawHandle = (req.body.handle || "").trim().toLowerCase();
    const description = (req.body.description || "").trim();

    // Валидируем название
    if (!title || title.length < 3 || title.length > 60) {
      return res.status(400).json({ ok: false, error: "Название должно быть от 3 до 60 символов" });
    }

    // Валидируем и проверяем уникальность ника
    const NEXFERY_HANDLE_REGEX = /^[a-z][a-z0-9_]{4,29}$/;
    if (!NEXFERY_HANDLE_REGEX.test(rawHandle)) {
      return res.status(400).json({ ok: false, error: "Ник должен быть 5-30 символов, начинаться с буквы" });
    }

    const handleCheck = await pool.query(
      "SELECT id FROM nexferies WHERE handle = $1",
      [rawHandle]
    );
    if (handleCheck.rowCount > 0) {
      return res.status(400).json({ ok: false, error: "Такой ник нексферы уже занят" });
    }

    // Обработка аватара
    let avatarData = null;
    if (req.file) {
      const fileData = fs.readFileSync(req.file.path);
      const base64Data = fileData.toString('base64');
      const mimeType = req.file.mimetype;
      avatarData = `data:${mimeType};base64,${base64Data}`;
      
      // Удаляем временный файл
      fs.unlinkSync(req.file.path);
    }

    // Создаём нексферу
    const result = await pool.query(
      `
      INSERT INTO nexferies (title, handle, description, avatar_data, author_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, title, handle, description, avatar_data, author_id, created_at
      `,
      [title, rawHandle, description, avatarData, userId]
    );

    const nexfery = result.rows[0];

    // Автор автоматически становится членом
    await pool.query(
      "INSERT INTO nexferies_members (nexfery_id, user_id, role) VALUES ($1, $2, $3)",
      [nexfery.id, userId, 'owner']
    );

    // Уведомляем всех клиентов об обновлении нексфер
    io.emit("nexferies:updated");

    // Получаем автора
    const authorResult = await pool.query(
      "SELECT username, display_name FROM users WHERE id = $1",
      [userId]
    );
    const author = authorResult.rows[0];

    res.json({ ok: true, nexfery: {
      id: nexfery.id,
      title: nexfery.title,
      handle: nexfery.handle,
      description: nexfery.description,
      avatarData: nexfery.avatar_data,
      author: author.display_name || author.username,
      authorId: nexfery.author_id,
      createdAt: nexfery.created_at
    }});
  } catch (err) {
    console.error("Ошибка при создании нексферы:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// Получить список нексфер текущего пользователя
app.get("/api/nexferies", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const result = await pool.query(
      `
      SELECT 
        n.id, n.title, n.handle, n.description, n.avatar_data, n.author_id, n.created_at,
        u.username as author_username, u.display_name as author_display_name,
        (SELECT COUNT(*) FROM nexferies_members WHERE nexfery_id = n.id) as members_count,
        (SELECT COUNT(*) FROM nexferies_messages WHERE nexfery_id = n.id) as messages_count
      FROM nexferies n
      JOIN nexferies_members nm ON n.id = nm.nexfery_id
      JOIN users u ON n.author_id = u.id
      WHERE nm.user_id = $1
      ORDER BY n.created_at DESC
      `,
      [userId]
    );

    res.json({ ok: true, nexferies: result.rows.map(row => ({
      id: row.id,
      title: row.title,
      handle: row.handle,
      description: row.description,
      avatarData: row.avatar_data,
      author: row.author_display_name || row.author_username,
      authorId: row.author_id,
      createdAt: row.created_at,
      membersCount: parseInt(row.members_count),
      messagesCount: parseInt(row.messages_count)
    })) });
  } catch (err) {
    console.error("Ошибка при получении нексфер:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// Поиск публичных нексфер
app.get("/api/nexferies/search/all", requireAuth, async (req, res) => {
  try {
    const query = req.query.q || "";

    const result = await pool.query(
      `
      SELECT 
        n.id, n.title, n.handle, n.description, n.avatar_data, n.author_id, n.created_at,
        u.username as author_username, u.display_name as author_display_name,
        (SELECT COUNT(*) FROM nexferies_members WHERE nexfery_id = n.id) as members_count,
        (SELECT COUNT(*) FROM nexferies_messages WHERE nexfery_id = n.id) as messages_count
      FROM nexferies n
      JOIN users u ON n.author_id = u.id
      WHERE n.is_public = TRUE AND (n.title ILIKE $1 OR n.handle ILIKE $1)
      ORDER BY n.created_at DESC
      LIMIT 50
      `,
      [`%${query}%`]
    );

    res.json({ ok: true, nexferies: result.rows.map(row => ({
      id: row.id,
      title: row.title,
      handle: row.handle,
      description: row.description,
      avatarData: row.avatar_data,
      author: row.author_display_name || row.author_username,
      authorId: row.author_id,
      createdAt: row.created_at,
      membersCount: parseInt(row.members_count),
      messagesCount: parseInt(row.messages_count)
    })) });
  } catch (err) {
    console.error("Ошибка при поиске нексфер:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// Получить информацию о конкретной нексфере
app.get("/api/nexferies/:nexferyId", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const nexferyId = parseInt(req.params.nexferyId, 10);

    const result = await pool.query(
      `
      SELECT 
        n.id, n.title, n.handle, n.description, n.avatar_data, n.author_id, n.created_at,
        u.username as author_username, u.display_name as author_display_name,
        (SELECT COUNT(*) FROM nexferies_members WHERE nexfery_id = n.id) as members_count,
        (SELECT role FROM nexferies_members WHERE nexfery_id = n.id AND user_id = $1) as user_role
      FROM nexferies n
      JOIN users u ON n.author_id = u.id
      WHERE n.id = $2
      `,
      [userId, nexferyId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Нексфера не найдена" });
    }

    const row = result.rows[0];
    res.json({ ok: true, nexfery: {
      id: row.id,
      title: row.title,
      handle: row.handle,
      description: row.description,
      avatarData: row.avatar_data,
      author: row.author_display_name || row.author_username,
      authorId: row.author_id,
      createdAt: row.created_at,
      membersCount: parseInt(row.members_count),
      userRole: row.user_role
    }});
  } catch (err) {
    console.error("Ошибка при получении информации о нексфере:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// Присоединиться к нексфере
app.post("/api/nexferies/:nexferyId/join", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const nexferyId = parseInt(req.params.nexferyId, 10);

    // Проверяем, что нексфера существует
    const nexferyCheck = await pool.query(
      "SELECT id FROM nexferies WHERE id = $1",
      [nexferyId]
    );

    if (nexferyCheck.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Нексфера не найдена" });
    }

    // Добавляем пользователя членом
    await pool.query(
      `
      INSERT INTO nexferies_members (nexfery_id, user_id, role)
      VALUES ($1, $2, 'member')
      ON CONFLICT (nexfery_id, user_id) DO NOTHING
      `,
      [nexferyId, userId]
    );

    // Отправляем событие всем подключённым
    io.emit("nexferies:updated");

    res.json({ ok: true });
  } catch (err) {
    console.error("Ошибка при присоединении к нексфере:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// Выйти из нексферы
app.post("/api/nexferies/:nexferyId/leave", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const nexferyId = parseInt(req.params.nexferyId, 10);

    // Проверяем, что пользователь не владелец
    const ownerCheck = await pool.query(
      "SELECT author_id FROM nexferies WHERE id = $1",
      [nexferyId]
    );

    if (ownerCheck.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Нексфера не найдена" });
    }

    if (ownerCheck.rows[0].author_id === userId) {
      return res.status(400).json({ ok: false, error: "Владелец не может выйти из нексферы" });
    }

    // Удаляем пользователя
    await pool.query(
      "DELETE FROM nexferies_members WHERE nexfery_id = $1 AND user_id = $2",
      [nexferyId, userId]
    );

    // Отправляем событие
    io.emit("nexferies:updated");

    res.json({ ok: true });
  } catch (err) {
    console.error("Ошибка при выходе из нексферы:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// Получить сообщения нексферы (с pagination и реакциями)
app.get("/api/nexferies/:nexferyId/messages", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const nexferyId = parseInt(req.params.nexferyId, 10);
    const limit = Math.min(parseInt(req.query.limit) || 50, 100); // макс 100
    const offset = parseInt(req.query.offset) || 0;

    // Проверяем, что пользователь член нексферы
    const memberCheck = await pool.query(
      "SELECT 1 FROM nexferies_members WHERE nexfery_id = $1 AND user_id = $2",
      [nexferyId, userId]
    );

    if (memberCheck.rowCount === 0) {
      return res.status(403).json({ ok: false, error: "Вы не член этой нексферы" });
    }

    // Получаем общее количество сообщений
    const countResult = await pool.query(
      "SELECT COUNT(*) as total FROM nexferies_messages WHERE nexfery_id = $1",
      [nexferyId]
    );
    const total = parseInt(countResult.rows[0].total);

    // Получаем сообщения с JOIN для оптимизации
    const result = await pool.query(
      `
      SELECT 
        m.id, m.text, m.file_url, m.file_type, m.file_name, m.created_at,
        m.is_edited, m.edited_at, m.author_id,
        u.username, u.display_name, u.avatar_data,
        array_agg(json_build_object('emoji', r.emoji, 'count', r.reaction_count) ORDER BY r.emoji) FILTER (WHERE r.emoji IS NOT NULL) as reactions
      FROM nexferies_messages m
      JOIN users u ON m.author_id = u.id
      LEFT JOIN (
        SELECT message_id, emoji, COUNT(*) as reaction_count
        FROM message_reactions
        GROUP BY message_id, emoji
      ) r ON m.id = r.message_id
      WHERE m.nexfery_id = $1
      GROUP BY m.id, u.username, u.display_name, u.avatar_data
      ORDER BY m.created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [nexferyId, limit, offset]
    );

    // Трансформируем результаты
    const messages = result.rows.map(row => ({
      id: row.id,
      text: row.text,
      fileUrl: row.file_url,
      fileType: row.file_type,
      fileName: row.file_name,
      author: row.display_name || row.username,
      authorId: row.author_id,
      authorAvatar: row.avatar_data,
      createdAt: row.created_at,
      isEdited: row.is_edited,
      editedAt: row.edited_at,
      reactions: (row.reactions || []).reduce((acc, r) => {
        if (r.emoji) acc[r.emoji] = r.count;
        return acc;
      }, {}),
      isOwnMessage: row.author_id === userId
    })).reverse();

    res.json({ 
      ok: true, 
      messages: messages,
      pagination: {
        limit,
        offset,
        total,
        hasMore: offset + limit < total
      }
    });
  } catch (err) {
    console.error("Ошибка при получении сообщений нексферы:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// Отправить сообщение в нексферу
app.post("/api/nexferies/:nexferyId/messages", requireAuth, messageLimiter, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const nexferyId = parseInt(req.params.nexferyId, 10);
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ ok: false, error: "Сообщение не может быть пустым" });
    }

    // Проверяем, что пользователь член нексферы
    const memberCheck = await pool.query(
      "SELECT 1 FROM nexferies_members WHERE nexfery_id = $1 AND user_id = $2",
      [nexferyId, userId]
    );

    if (memberCheck.rowCount === 0) {
      return res.status(403).json({ ok: false, error: "Вы не член этой нексферы" });
    }

    // Сохраняем сообщение
    const result = await pool.query(
      `
      INSERT INTO nexferies_messages (nexfery_id, author_id, text)
      VALUES ($1, $2, $3)
      RETURNING id, text, created_at
      `,
      [nexferyId, userId, text.trim()]
    );

    const message = result.rows[0];

    // Получаем информацию об авторе
    const userResult = await pool.query(
      "SELECT username, display_name, avatar_data FROM users WHERE id = $1",
      [userId]
    );
    const author = userResult.rows[0];

    const msgData = {
      id: message.id,
      nexferyId,
      text: message.text,
      author: author.display_name || author.username,
      authorId: userId,
      authorAvatar: author.avatar_data,
      createdAt: message.created_at,
      isEdited: false,
      reactions: {},
      isOwnMessage: true
    };

    // Отправляем сообщение по сокету
    io.to(`nexfery:${nexferyId}`).emit("nexfery:new-message", msgData);

    res.json({ ok: true, message: msgData });
  } catch (err) {
    console.error("Ошибка при отправке сообщения в нексферу:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// Получить участников нексферы
app.get("/api/nexferies/:nexferyId/members", requireAuth, async (req, res) => {
  try {
    const nexferyId = parseInt(req.params.nexferyId, 10);

    const result = await pool.query(
      `
      SELECT 
        u.id, u.username, u.display_name, u.avatar_data, nm.role
      FROM nexferies_members nm
      JOIN users u ON nm.user_id = u.id
      WHERE nm.nexfery_id = $1
      ORDER BY nm.joined_at DESC
      `,
      [nexferyId]
    );

    res.json({ ok: true, members: result.rows.map(row => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarData: row.avatar_data,
      role: row.role
    })) });
  } catch (err) {
    console.error("Ошибка при получении участников нексферы:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ===== РЕДАКТИРОВАНИЕ СООБЩЕНИЯ =====
app.patch("/api/nexferies/:nexferyId/messages/:messageId", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const messageId = parseInt(req.params.messageId);
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ ok: false, error: "Текст не может быть пустым" });
    }

    // Проверяем что это сообщение пользователя
    const msgResult = await pool.query(
      "SELECT author_id, nexfery_id FROM nexferies_messages WHERE id = $1",
      [messageId]
    );

    if (msgResult.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Сообщение не найдено" });
    }

    const msg = msgResult.rows[0];
    if (msg.author_id !== userId) {
      return res.status(403).json({ ok: false, error: "Вы не автор сообщения" });
    }

    // Обновляем сообщение
    await pool.query(
      `UPDATE nexferies_messages 
       SET text = $1, is_edited = true, edited_at = NOW()
       WHERE id = $2`,
      [text.trim(), messageId]
    );

    // Уведомляем
    io.to(`nexfery:${msg.nexfery_id}`).emit("message:edited", {
      messageId,
      text: text.trim(),
      editedAt: new Date()
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Ошибка при редактировании сообщения:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ===== УДАЛЕНИЕ СООБЩЕНИЯ =====
app.delete("/api/nexferies/:nexferyId/messages/:messageId", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const messageId = parseInt(req.params.messageId);
    const nexferyId = parseInt(req.params.nexferyId);

    // Проверяем что это сообщение пользователя или он админ нексферы
    const msgResult = await pool.query(
      "SELECT author_id FROM nexferies_messages WHERE id = $1",
      [messageId]
    );

    if (msgResult.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Сообщение не найдено" });
    }

    const msg = msgResult.rows[0];
    
    // Проверяем права
    const roleResult = await pool.query(
      "SELECT role FROM nexferies_members WHERE nexfery_id = $1 AND user_id = $2",
      [nexferyId, userId]
    );

    if (msg.author_id !== userId && roleResult.rows[0]?.role !== 'owner') {
      return res.status(403).json({ ok: false, error: "Недостаточно прав" });
    }

    // Удаляем сообщение
    await pool.query("DELETE FROM nexferies_messages WHERE id = $1", [messageId]);

    // Уведомляем
    io.to(`nexfery:${nexferyId}`).emit("message:deleted", { messageId });

    res.json({ ok: true });
  } catch (err) {
    console.error("Ошибка при удалении сообщения:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ===== РЕАКЦИИ НА СООБЩЕНИЯ =====
app.post("/api/messages/:messageId/react", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const messageId = parseInt(req.params.messageId);
    const { emoji } = req.body;

    if (!emoji || emoji.length > 10) {
      return res.status(400).json({ ok: false, error: "Некорректный emoji" });
    }

    // Получаем нексферу из сообщения
    const msgResult = await pool.query(
      "SELECT nexfery_id FROM nexferies_messages WHERE id = $1",
      [messageId]
    );

    if (msgResult.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Сообщение не найдено" });
    }

    const nexferyId = msgResult.rows[0].nexfery_id;

    // Проверяем членство
    const memberCheck = await pool.query(
      "SELECT 1 FROM nexferies_members WHERE nexfery_id = $1 AND user_id = $2",
      [nexferyId, userId]
    );

    if (memberCheck.rowCount === 0) {
      return res.status(403).json({ ok: false, error: "Недостаточно прав" });
    }

    // Добавляем реакцию
    await pool.query(
      `INSERT INTO message_reactions (message_id, user_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
      [messageId, userId, emoji]
    );

    // Broadcast реакции
    io.to(`nexfery:${nexferyId}`).emit("reaction:added", {
      messageId,
      userId,
      emoji
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Ошибка при добавлении реакции:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ===== УДАЛЕНИЕ РЕАКЦИИ =====
app.delete("/api/messages/:messageId/react", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const messageId = parseInt(req.params.messageId);
    const { emoji } = req.body;

    if (!emoji) {
      return res.status(400).json({ ok: false, error: "Emoji требуется" });
    }

    // Получаем нексферу
    const msgResult = await pool.query(
      "SELECT nexfery_id FROM nexferies_messages WHERE id = $1",
      [messageId]
    );

    if (msgResult.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Сообщение не найдено" });
    }

    const nexferyId = msgResult.rows[0].nexfery_id;

    // Удаляем реакцию
    await pool.query(
      "DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3",
      [messageId, userId, emoji]
    );

    // Broadcast удаление
    io.to(`nexfery:${nexferyId}`).emit("reaction:removed", {
      messageId,
      userId,
      emoji
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Ошибка при удалении реакции:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ===== ПРИГЛАШЕНИЯ В НЕКСФЕРЫ =====
app.post("/api/nexferies/:nexferyId/invite", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const nexferyId = parseInt(req.params.nexferyId);
    const { invitedUserId } = req.body;

    // Проверяем что пользователь владелец или администратор
    const roleCheck = await pool.query(
      "SELECT role FROM nexferies_members WHERE nexfery_id = $1 AND user_id = $2",
      [nexferyId, userId]
    );

    if (roleCheck.rowCount === 0 || !['owner', 'admin'].includes(roleCheck.rows[0].role)) {
      return res.status(403).json({ ok: false, error: "Недостаточно прав" });
    }

    // Проверяем что приглашённый не участник
    const memberCheck = await pool.query(
      "SELECT 1 FROM nexferies_members WHERE nexfery_id = $1 AND user_id = $2",
      [nexferyId, invitedUserId]
    );

    if (memberCheck.rowCount > 0) {
      return res.status(400).json({ ok: false, error: "Пользователь уже участник" });
    }

    // Создаём приглашение
    const result = await pool.query(
      `INSERT INTO nexfery_invites (nexfery_id, invited_user_id, invited_by_user_id)
       VALUES ($1, $2, $3)
       RETURNING id, created_at, expires_at`,
      [nexferyId, invitedUserId, userId]
    );

    // Уведомляем пользователя
    io.emit("invitation:new", {
      inviteId: result.rows[0].id,
      nexferyId: nexferyId,
      invitedUserId: invitedUserId
    });

    res.json({ ok: true, invite: result.rows[0] });
  } catch (err) {
    console.error("Ошибка при приглашении:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ===== ПРИНЯТЬ ПРИГЛАШЕНИЕ =====
app.post("/api/nexferies/invites/:inviteId/accept", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const inviteId = parseInt(req.params.inviteId);

    // Получить приглашение
    const inviteResult = await pool.query(
      "SELECT * FROM nexfery_invites WHERE id = $1 AND invited_user_id = $2 AND status = 'pending'",
      [inviteId, userId]
    );

    if (inviteResult.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Приглашение не найдено или уже обработано" });
    }

    const invite = inviteResult.rows[0];

    // Добавить в участники
    await pool.query(
      "INSERT INTO nexferies_members (nexfery_id, user_id, role) VALUES ($1, $2, 'member')",
      [invite.nexfery_id, userId]
    );

    // Отметить как принято
    await pool.query(
      "UPDATE nexfery_invites SET status = 'accepted' WHERE id = $1",
      [inviteId]
    );

    // Уведомить всех в нексфере
    io.to(`nexfery:${invite.nexfery_id}`).emit("member:joined", {
      nexferyId: invite.nexfery_id,
      userId: userId
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Ошибка при принятии приглашения:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ===== ОТКЛОНИТЬ ПРИГЛАШЕНИЕ =====
app.post("/api/nexferies/invites/:inviteId/decline", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const inviteId = parseInt(req.params.inviteId);

    const inviteResult = await pool.query(
      "SELECT * FROM nexfery_invites WHERE id = $1 AND invited_user_id = $2 AND status = 'pending'",
      [inviteId, userId]
    );

    if (inviteResult.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Приглашение не найдено" });
    }

    // Отметить как отклонено
    await pool.query(
      "UPDATE nexfery_invites SET status = 'declined' WHERE id = $1",
      [inviteId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Ошибка при отклонении приглашения:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ===== УДАЛЕНИЕ НЕКСФЕРЫ =====
app.delete("/api/nexferies/:nexferyId", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const nexferyId = parseInt(req.params.nexferyId);

    // Проверяем что пользователь владелец
    const ownerCheck = await pool.query(
      "SELECT author_id FROM nexferies WHERE id = $1",
      [nexferyId]
    );

    if (ownerCheck.rowCount === 0 || ownerCheck.rows[0].author_id !== userId) {
      return res.status(403).json({ ok: false, error: "Только владелец может удалить нексферу" });
    }

    // Удаляем (CASCADE удалит все связанные данные)
    await pool.query("DELETE FROM nexferies WHERE id = $1", [nexferyId]);

    // Уведомляем всех в комнате
    io.to(`nexfery:${nexferyId}`).emit("nexfery:deleted", { nexferyId });

    // Отправляем событие обновления ленты
    io.emit("nexus:updated");

    res.json({ ok: true });
  } catch (err) {
    console.error("Ошибка при удалении нексферы:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ===== TYPING INDICATOR =====
app.post("/api/nexferies/:nexferyId/typing", requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const nexferyId = parseInt(req.params.nexferyId);
    const { isTyping } = req.body;

    // Уведомляем об этом в комнате
    io.to(`nexfery:${nexferyId}`).emit("user:typing", {
      userId,
      isTyping
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Ошибка при отправке typing indicator:", err);
    res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ===== ПОЛУЧЕНИЕ ИНФОРМАЦИИ О ПОЛЬЗОВАТЕЛЕ =======
app.get("/api/user/:userId", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, error: "Не авторизирован" });
  }

  try {
    const { userId } = req.params;
    const result = await pool.query(
      "SELECT id, username, display_name, avatar_data FROM users WHERE id = $1",
      [userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Пользователь не найден" });
    }

    const user = result.rows[0];
    return res.json({
      ok: true,
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      avatarUrl: user.avatar_data,
    });
  } catch (err) {
    console.error("Ошибка при получении информации о пользователе:", err);
    return res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ======= БЛОКИРОВКА/РАЗБЛОКИРОВКА ПОЛЬЗОВАТЕЛЕЙ =======

// Получить статус блокировки
app.get("/api/block-status/:userId", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, error: "Не авторизирован" });
  }

  try {
    const { userId } = req.params;
    const result = await pool.query(
      "SELECT 1 FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2 LIMIT 1;",
      [req.session.user.id, userId]
    );

    return res.json({ ok: true, isBlocked: result.rowCount > 0 });
  } catch (err) {
    console.error("Ошибка при проверке блокировки:", err);
    return res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// Проверить заблокирован ли я этим пользователем
app.get("/api/am-i-blocked/:userId", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, error: "Не авторизирован" });
  }

  try {
    const { userId } = req.params;
    const result = await pool.query(
      "SELECT 1 FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2 LIMIT 1;",
      [userId, req.session.user.id]
    );

    return res.json({ ok: true, amBlocked: result.rowCount > 0 });
  } catch (err) {
    console.error("Ошибка при проверке блокировки:", err);
    return res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// Заблокировать пользователя
app.post("/api/block-user/:userId", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, error: "Не авторизирован" });
  }

  try {
    const { userId } = req.params;
    const blockerId = req.session.user.id;

    // Нельзя заблокировать самого себя
    if (parseInt(userId) === blockerId) {
      return res.status(400).json({ ok: false, error: "Нельзя заблокировать себя" });
    }

    // Вставляем (если уже заблокирован, будет игнорировано из-за PRIMARY KEY)
    await pool.query(
      "INSERT INTO blocked_users (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;",
      [blockerId, userId]
    );

    // Получаем информацию о блокирующем пользователе для системного сообщения
    const blockerInfo = await pool.query(
      "SELECT username, display_name FROM users WHERE id = $1",
      [blockerId]
    );
    const blockerName = blockerInfo.rows.length > 0 
      ? (blockerInfo.rows[0].display_name || blockerInfo.rows[0].username)
      : 'Пользователь';

    // Найдём чат между пользователями и сохраним системное сообщение
    const chatResult = await pool.query(
      `
      SELECT c.id FROM chats c
      JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = $1
      JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = $2
      `,
      [blockerId, userId]
    );

    if (chatResult.rowCount > 0) {
      const chatId = chatResult.rows[0].id;
      
      try {
        // Сохраняем системное сообщение в БД
        await pool.query(
          `
          INSERT INTO messages (chat_id, sender_id, text, is_system)
          VALUES ($1, NULL, $2, true)
          `,
          [chatId, `${blockerName} заблокировал пользователя`]
        );
      } catch (err) {
        console.error("Ошибка при сохранении системного сообщения:", err);
      }
    }

    // Отправляем событие обоим пользователям для обновления UI
    const blockerUser = onlineUsers.get(parseInt(blockerId));
    const blockedUser = onlineUsers.get(parseInt(userId));
    
    const blockEvent = { blockerId: parseInt(blockerId), blockedId: parseInt(userId) };
    
    if (blockerUser) {
      io.to(blockerUser.socketId).emit("user:blocked", blockEvent);
    }
    if (blockedUser) {
      io.to(blockedUser.socketId).emit("user:blocked", blockEvent);
    }

    // Отправляем событие обновления сообщений в комнату чата
    if (chatResult.rowCount > 0) {
      const chatId = chatResult.rows[0].id;
      io.to(`chat:${chatId}`).emit("chats:updated");
      // Отправляем события блокировки в комнату чата для обоих пользователей
      io.to(`chat:${chatId}`).emit("user:blocked", blockEvent);
    }

    return res.json({ ok: true, isBlocked: true });
  } catch (err) {
    console.error("Ошибка при блокировке:", err);
    return res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// Разблокировать пользователя
app.post("/api/unblock-user/:userId", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ ok: false, error: "Не авторизирован" });
  }

  try {
    const { userId } = req.params;
    const blockerId = req.session.user.id;

    await pool.query(
      "DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2;",
      [blockerId, userId]
    );

    // Получаем информацию о разблокирующем пользователе для системного сообщения
    const blockerInfo = await pool.query(
      "SELECT username, display_name FROM users WHERE id = $1",
      [blockerId]
    );
    const blockerName = blockerInfo.rows.length > 0 
      ? (blockerInfo.rows[0].display_name || blockerInfo.rows[0].username)
      : 'Пользователь';

    // Найдём чат между пользователями и сохраним системное сообщение
    const chatResult = await pool.query(
      `
      SELECT c.id FROM chats c
      JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = $1
      JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = $2
      `,
      [blockerId, userId]
    );

    if (chatResult.rowCount > 0) {
      const chatId = chatResult.rows[0].id;
      
      try {
        // Сохраняем системное сообщение в БД
        await pool.query(
          `
          INSERT INTO messages (chat_id, sender_id, text, is_system)
          VALUES ($1, NULL, $2, true)
          `,
          [chatId, `${blockerName} разблокировал пользователя`]
        );
      } catch (err) {
        console.error("Ошибка при сохранении системного сообщения:", err);
      }
    }

    // Отправляем событие обоим пользователям для обновления UI
    const blockerUser = onlineUsers.get(parseInt(blockerId));
    const unblockedUser = onlineUsers.get(parseInt(userId));
    
    const unblockEvent = { blockerId: parseInt(blockerId), unblockedId: parseInt(userId) };
    
    if (blockerUser) {
      io.to(blockerUser.socketId).emit("user:unblocked", unblockEvent);
    }
    if (unblockedUser) {
      io.to(unblockedUser.socketId).emit("user:unblocked", unblockEvent);
    }

    // Отправляем событие обновления сообщений в комнату чата
    if (chatResult.rowCount > 0) {
      const chatId = chatResult.rows[0].id;
      io.to(`chat:${chatId}`).emit("chats:updated");
      // Отправляем события разблокировки в комнату чата для обоих пользователей
      io.to(`chat:${chatId}`).emit("user:unblocked", unblockEvent);
    }

    return res.json({ ok: true, isBlocked: false });
  } catch (err) {
    console.error("Ошибка при разблокировке:", err);
    return res.status(500).json({ ok: false, error: "Ошибка сервера" });
  }
});

// ======= АДМИН ENDPOINTS =======

// Endpoint для аутентификации админа
app.post("/admin/auth", async (req, res) => {
  const { password } = req.body;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1001qppqA"; // Можно изменить в .env
  
  if (password === ADMIN_PASSWORD) {
    req.session.admin = true;
    req.session.save((err) => {
      if (err) {
        return res.status(500).json({ ok: false, error: "Session error" });
      }
      res.json({ ok: true });
    });
  } else {
    res.status(401).json({ ok: false, error: "Неверный пароль" });
  }
});

// Middleware для проверки админа
async function checkAdmin(req, res, next) {
  if (!req.session || !req.session.admin) {
    return res.status(401).json({ ok: false, error: "Not authenticated" });
  }
  next();
}

// Проверить сессию админа
app.get("/admin/check-session", (req, res) => {
  if (req.session && req.session.admin) {
    res.json({ ok: true, authenticated: true });
  } else {
    res.json({ ok: true, authenticated: false });
  }
});

// Получить статистику
app.get("/admin/stats", checkAdmin, async (req, res) => {
  try {
    const usersResult = await pool.query("SELECT COUNT(*) as count FROM users");
    const chatsResult = await pool.query("SELECT COUNT(*) as count FROM chats");
    const messagesResult = await pool.query("SELECT COUNT(*) as count FROM messages");
    
    // Получить пользователей за последние 7 дней
    const weekAgoUsers = await pool.query(
      "SELECT COUNT(*) as count FROM users WHERE created_at >= NOW() - INTERVAL '7 days'"
    );
    
    // Получить сообщений за последние 7 дней
    const weekAgoMessages = await pool.query(
      "SELECT COUNT(*) as count FROM messages WHERE created_at >= NOW() - INTERVAL '7 days'"
    );
    
    // Получить чатов за последние 7 дней
    const weekAgoChats = await pool.query(
      "SELECT COUNT(*) as count FROM chats WHERE created_at >= NOW() - INTERVAL '7 days'"
    );
    
    const totalUsers = parseInt(usersResult.rows[0].count);
    const newUsersWeek = parseInt(weekAgoUsers.rows[0].count);
    
    res.json({
      totalUsers: totalUsers,
      onlineUsers: onlineUsers.size,
      totalChats: parseInt(chatsResult.rows[0].count),
      totalMessages: parseInt(messagesResult.rows[0].count),
      newUsersWeek: newUsersWeek,
      newMessagesWeek: parseInt(weekAgoMessages.rows[0].count),
      newChatsWeek: parseInt(weekAgoChats.rows[0].count)
    });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Получить всех пользователей
app.get("/admin/users", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, username, email, is_admin, created_at, last_seen
      FROM users 
      ORDER BY created_at DESC 
      LIMIT 100
    `);
    
    res.json(result.rows.map(u => {
      const userStatus = userStatuses.get(u.id);
      let statusText = '❌ Не в сети';
      let statusDetail = '';
      
      if (onlineUsers.has(u.id)) {
        if (userStatus?.status === 'typing') {
          statusText = '📝 Печатает...';
        } else if (userStatus?.status === 'recording_voice') {
          statusText = '🎤 Записывает голосовое сообщение...';
        } else if (userStatus?.status === 'sending_photo') {
          statusText = '📸 Отправляет фото...';
        } else if (userStatus?.status === 'sending_video') {
          statusText = '🎥 Отправляет видео...';
        } else {
          statusText = '✅ В сети';
        }
      } else if (u.last_seen) {
        const lastSeenDate = new Date(u.last_seen);
        const now = new Date();
        const diffMs = now - lastSeenDate;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);
        
        if (diffMins < 1) {
          statusDetail = 'только что';
        } else if (diffMins < 60) {
          statusDetail = `${diffMins} мин назад`;
        } else if (diffHours < 24) {
          statusDetail = `${diffHours} ч назад`;
        } else if (diffDays < 7) {
          statusDetail = `${diffDays} д назад`;
        } else {
          statusDetail = lastSeenDate.toLocaleDateString('ru-RU');
        }
        statusText = `был в сети ${statusDetail}`;
      }
      
      return {
        id: u.id,
        username: u.username,
        email: u.email,
        is_admin: u.is_admin,
        online: onlineUsers.has(u.id),
        status: statusText,
        created_at: u.created_at,
        last_seen: u.last_seen
      };
    }));
  } catch (err) {
    console.error("Users fetch error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Добавить пользователя
app.post("/admin/users", checkAdmin, async (req, res) => {
  const { username, email, password, is_admin } = req.body;
  
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const result = await pool.query(
      "INSERT INTO users (username, email, password_hash, is_admin) VALUES ($1, $2, $3, $4) RETURNING id, username, email, is_admin, created_at",
      [username, email, hashedPassword, is_admin || false]
    );
    
    const newUser = result.rows[0];
    // Эмитить обновление для админ-панели
    io.emit('users-update');
    io.emit('stats-update', {
      onlineUsers: onlineUsers.size
    });
    
    res.json({ 
      ok: true, 
      userId: newUser.id,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        is_admin: newUser.is_admin,
        created_at: newUser.created_at,
        online: false
      }
    });
  } catch (err) {
    console.error("User creation error:", err);
    res.status(500).json({ ok: false, error: err.message || "Server error" });
  }
});

// Удалить пользователя
app.delete("/admin/users/:userId", checkAdmin, async (req, res) => {
  const { userId } = req.params;
  
  try {
    await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    // Эмитить обновление для админ-панели
    io.emit('users-update');
    io.emit('stats-update', {
      onlineUsers: onlineUsers.size
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("User deletion error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Получить все чаты
app.get("/admin/chats", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.id, c.created_at,
             (SELECT COUNT(*) FROM chat_members WHERE chat_id = c.id) as members,
             (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) as messages
      FROM chats c
      ORDER BY c.created_at DESC
      LIMIT 100
    `);
    
    res.json(result.rows.map(c => ({
      id: c.id,
      name: `Chat #${c.id}`,
      members: parseInt(c.members),
      messages: parseInt(c.messages),
      created_at: c.created_at
    })));
  } catch (err) {
    console.error("Chats fetch error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Удалить чат
app.delete("/admin/chats/:chatId", checkAdmin, async (req, res) => {
  const { chatId } = req.params;
  
  try {
    await pool.query("DELETE FROM chats WHERE id = $1", [chatId]);
    // Эмитить обновление для админ-панели
    io.emit('chats-update');
    io.emit('stats-update', {
      onlineUsers: onlineUsers.size
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Chat deletion error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Получить все сообщения
app.get("/admin/messages", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT m.id, m.chat_id, m.text, m.created_at,
             u.username as author,
             (SELECT STRING_AGG(u2.username, ', ')
              FROM chat_members cm
              LEFT JOIN users u2 ON cm.user_id = u2.id
              WHERE cm.chat_id = m.chat_id AND cm.user_id != m.author_id
              LIMIT 3) as recipients
      FROM messages m
      LEFT JOIN users u ON m.author_id = u.id
      ORDER BY m.created_at DESC
      LIMIT 200
    `);
    
    res.json(result.rows.map(m => ({
      id: m.id,
      chat_id: m.chat_id,
      author: m.author || 'Unknown',
      recipients: m.recipients || 'N/A',
      content: m.text,
      created_at: m.created_at
    })));
  } catch (err) {
    console.error("Messages fetch error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Удалить сообщение
app.delete("/admin/messages/:messageId", checkAdmin, async (req, res) => {
  const { messageId } = req.params;
  
  try {
    await pool.query("DELETE FROM messages WHERE id = $1", [messageId]);
    // Эмитить обновление для админ-панели
    io.emit('messages-update');
    io.emit('stats-update', {
      onlineUsers: onlineUsers.size
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Message deletion error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ===== ADMIN PERMISSIONS ENDPOINTS =====

// Получить права пользователя
app.get("/admin/users/:userId/permissions", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT is_admin FROM users WHERE id = $1",
      [req.params.userId]
    );
    
    if (!result.rows[0]) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    res.json({
      ok: true,
      permissions: {
        is_admin: result.rows[0].is_admin || false,
        can_edit_content: result.rows[0].is_admin || false,
        can_delete_messages: result.rows[0].is_admin || false,
        can_manage_users: result.rows[0].is_admin || false
      }
    });
  } catch (err) {
    console.error("Permissions fetch error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Обновить права пользователя
app.put("/admin/users/:userId/permissions", checkAdmin, async (req, res) => {
  const { is_admin } = req.body;
  
  try {
    await pool.query(
      "UPDATE users SET is_admin = $1 WHERE id = $2",
      [is_admin || false, req.params.userId]
    );
    
    res.json({ ok: true });
  } catch (err) {
    console.error("Permissions update error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ===== ADMIN CONTENT ENDPOINTS =====

// Обновить текстовый контент
app.post("/admin/content/text", checkAdmin, async (req, res) => {
  const { section, content } = req.body;
  
  if (!section || !content) {
    return res.status(400).json({ ok: false, error: "Missing fields" });
  }

  try {
    // Сохраняем контент в БД или файл
    const contentPath = path.join(__dirname, 'public', 'content.json');
    let data = {};
    
    if (fs.existsSync(contentPath)) {
      data = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
    }
    
    data[section] = content;
    fs.writeFileSync(contentPath, JSON.stringify(data, null, 2));
    
    res.json({ ok: true });
  } catch (err) {
    console.error("Content save error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Загрузить изображение контента
app.post("/admin/content/image", checkAdmin, multer({ storage: multer.memoryStorage() }).single('image'), async (req, res) => {
  const { section } = req.body;
  
  if (!section || !req.file) {
    return res.status(400).json({ ok: false, error: "Missing fields" });
  }

  try {
    const uploadsDir = path.join(__dirname, 'public', 'uploads', 'content');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const filename = `${section}-${Date.now()}.${req.file.mimetype.split('/')[1]}`;
    const filepath = path.join(uploadsDir, filename);
    
    fs.writeFileSync(filepath, req.file.buffer);
    
    // Сохраняем ссылку в БД
    const contentPath = path.join(__dirname, 'public', 'content.json');
    let data = {};
    
    if (fs.existsSync(contentPath)) {
      data = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
    }
    
    if (!data.images) data.images = {};
    data.images[section] = `/uploads/content/${filename}`;
    fs.writeFileSync(contentPath, JSON.stringify(data, null, 2));
    
    res.json({ ok: true, url: `/uploads/content/${filename}` });
  } catch (err) {
    console.error("Image upload error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Получить контент
app.get("/admin/content", checkAdmin, async (req, res) => {
  try {
    const contentPath = path.join(__dirname, 'public', 'content.json');
    let data = {};
    
    if (fs.existsSync(contentPath)) {
      data = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
    }
    
    res.json({ ok: true, content: data });
  } catch (err) {
    console.error("Content fetch error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ===== SETTINGS ENDPOINTS =====

// Получить настройки
app.get("/admin/settings", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT key, value FROM settings");
    const settings = {};
    result.rows.forEach(row => {
      settings[row.key] = row.value;
    });
    res.json(settings);
  } catch (err) {
    console.error("Settings fetch error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Сохранить настройки
app.post("/admin/settings", checkAdmin, async (req, res) => {
  const { site_name, max_file_size } = req.body;
  
  try {
    // Сохраняем название сайта
    if (site_name !== undefined) {
      await pool.query(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()",
        ["site_name", String(site_name)]
      );
    }
    
    // Сохраняем максимальный размер файла
    if (max_file_size !== undefined) {
      const maxSize = Math.max(1, Math.min(500, parseInt(max_file_size) || 50)); // от 1 до 500 MB
      await pool.query(
        "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()",
        ["max_file_size", String(maxSize)]
      );
    }
    
    // Эмитим обновление
    io.emit('settings-update', { site_name, max_file_size });
    
    res.json({ ok: true });
  } catch (err) {
    console.error("Settings save error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ======= ЗАПУСК СЕРВЕРА =======
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
