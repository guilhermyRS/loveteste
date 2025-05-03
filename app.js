const express = require("express")
const path = require("path")
const multer = require("multer")
const sqlite3 = require("sqlite3").verbose()
const QRCode = require("qrcode")
const dayjs = require("dayjs")
const duration = require("dayjs/plugin/duration")
const customParseFormat = require("dayjs/plugin/customParseFormat")
const relativeTime = require("dayjs/plugin/relativeTime")
const utc = require("dayjs/plugin/utc")
const timezone = require("dayjs/plugin/timezone")
const os = require("os")
const fs = require("fs")
const http = require("http")
const { Server } = require("socket.io")

// Extend dayjs with plugins
dayjs.extend(duration)
dayjs.extend(customParseFormat)
dayjs.extend(relativeTime)
dayjs.extend(utc)
dayjs.extend(timezone)

// Configurar o fuso horário para Brasília (GMT-3)
dayjs.tz.setDefault("America/Sao_Paulo")

const app = express()
const server = http.createServer(app)
const io = new Server(server)

const db = new sqlite3.Database("./db.sqlite")

// Modify the getLocalIP function to use environment variables for hosting
function getLocalIP() {
  // First check if we have a BASE_URL environment variable (for hosting)
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/^https?:\/\//, "")
  }

  // Otherwise use local IP detection
  const interfaces = os.networkInterfaces()
  for (const name in interfaces) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address
      }
    }
  }
  return "localhost"
}

const localIP = getLocalIP()
const PORT = process.env.PORT || 3000
const baseUrl = process.env.BASE_URL || `http://${localIP}:${PORT}`

// Express configurations
app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.use(express.static("public"))
app.use("/uploads", express.static(path.join(__dirname, "uploads")))
app.set("view engine", "ejs")

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, "uploads")
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

// Configure Multer for image uploads
const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9)
    cb(null, unique + path.extname(file.originalname))
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    // Accept only images
    if (file.mimetype.startsWith("image/")) {
      cb(null, true)
    } else {
      cb(new Error("Apenas imagens são permitidas!"), false)
    }
  },
})

// Create database tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS declaracoes (
      id INTEGER PRIMARY KEY,
      nome1 TEXT,
      nome2 TEXT,
      texto TEXT,
      data_inicio TEXT,
      slug TEXT UNIQUE,
      layout TEXT,
      imagens TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      theme TEXT DEFAULT 'default'
    )
  `)

  // New table for comments
  db.run(`
    CREATE TABLE IF NOT EXISTS comentarios (
      id INTEGER PRIMARY KEY,
      declaracao_id INTEGER,
      nome TEXT,
      comentario TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (declaracao_id) REFERENCES declaracoes (id)
    )
  `)
})

// Modificar o intervalo de atualização do tempo para ser mais frequente
// Localizar a parte onde configuramos o Socket.IO

// Socket.IO connection
io.on("connection", (socket) => {
  console.log("Um usuário conectou")

  // Join a specific story room based on the story slug
  socket.on("join-story", (slug) => {
    socket.join(slug)
    console.log(`Usuário entrou na sala: ${slug}`)
  })

  // Broadcast time updates to all connected clients every second
  setInterval(() => {
    io.emit("time-update", {
      timestamp: Date.now(),
    })
  }, 1000) // Atualiza a cada segundo

  socket.on("disconnect", () => {
    console.log("Usuário desconectou")
  })
})

// Home page route
app.get("/", (req, res) => {
  res.render("form", {
    error: null,
    formData: {},
    pageTitle: "Crie Sua História de Amor",
  })
})

// Process form submission
app.post("/criar", upload.array("imagens", 5), (req, res) => {
  const { nome1, nome2, texto, data_inicio, slug, layout, theme } = req.body
  const imagens = req.files || []

  // Validate slug format (only letters, numbers, and hyphens)
  const slugRegex = /^[a-z0-9-]+$/
  if (!slugRegex.test(slug)) {
    return res.render("form", {
      error: "URL personalizada deve conter apenas letras minúsculas, números e hífens.",
      formData: { nome1, nome2, texto, data_inicio, slug, layout, theme },
      pageTitle: "Crie Sua História de Amor",
    })
  }

  const quantidadeEsperada = layout === "carta" ? 3 : 5

  if (imagens.length !== quantidadeEsperada) {
    return res.render("form", {
      error: `Você precisa enviar exatamente ${quantidadeEsperada} imagem(ns) para o layout ${layout}.`,
      formData: { nome1, nome2, texto, data_inicio, slug, layout, theme },
      pageTitle: "Crie Sua História de Amor",
    })
  }

  const nomesArquivos = imagens.map((file) => file.filename).join(",")

  db.run(
    `INSERT INTO declaracoes (nome1, nome2, texto, data_inicio, slug, layout, imagens, theme) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [nome1, nome2, texto, data_inicio, slug, layout, nomesArquivos, theme || "default"],
    (err) => {
      if (err) {
        return res.render("form", {
          error: "URL personalizada já existe ou houve um erro ao salvar.",
          formData: { nome1, nome2, texto, data_inicio, slug, layout, theme },
          pageTitle: "Crie Sua História de Amor",
        })
      }
      res.redirect(`/${slug}`)
    },
  )
})

// Update the URL generation to use the BASE_URL if available
app.get("/:slug", async (req, res) => {
  const slug = req.params.slug

  db.get("SELECT * FROM declaracoes WHERE slug = ?", [slug], async (err, row) => {
    if (!row) return res.status(404).render("404", { pageTitle: "Página não encontrada" })

    const imagens = row.imagens ? row.imagens.split(",") : []
    const url = `${baseUrl}/${slug}`
    const qrCode = await QRCode.toDataURL(url)

    // Corrigir o problema de fuso horário adicionando um dia à data
    // Primeiro, parse a data no formato YYYY-MM-DD
    const dataInicio = row.data_inicio

    // Criar a data usando o fuso horário de Brasília sem ajustes automáticos
    const inicio = dayjs.tz(dataInicio, "America/Sao_Paulo")
    const agora = dayjs().tz("America/Sao_Paulo")
    const diff = agora.diff(inicio)
    const duracao = dayjs.duration(diff)

    const tempoJuntos = `${duracao.years()} anos, ${duracao.months()} meses, ${duracao.days()} dias, ${duracao.hours()} horas, ${duracao.minutes()} minutos e ${duracao.seconds()} segundos`
    const tempoSimples = inicio.fromNow(true)

    // Get comments
    db.all(
      "SELECT * FROM comentarios WHERE declaracao_id = ? ORDER BY created_at DESC",
      [row.id],
      (err, comentarios) => {
        res.render(row.layout, {
          data: row,
          imagens,
          qrCode,
          tempoJuntos,
          tempoSimples,
          comentarios: comentarios || [],
          pageTitle: `${row.nome1} & ${row.nome2}`,
          baseUrl,
        })
      },
    )
  })
})

// Add comment
app.post("/:slug/comentar", express.urlencoded({ extended: true }), (req, res) => {
  const { nome, comentario } = req.body
  const slug = req.params.slug

  if (!nome || !comentario) {
    return res.redirect(`/${slug}?error=Preencha todos os campos`)
  }

  db.get("SELECT id FROM declaracoes WHERE slug = ?", [slug], (err, row) => {
    if (!row) return res.redirect("/")

    db.run(
      "INSERT INTO comentarios (declaracao_id, nome, comentario) VALUES (?, ?, ?)",
      [row.id, nome, comentario],
      function (err) {
        if (err) {
          return res.redirect(`/${slug}?error=Erro ao adicionar comentário`)
        }

        // Get the inserted comment with its ID
        db.get("SELECT * FROM comentarios WHERE id = ?", [this.lastID], (err, newComment) => {
          if (!err && newComment) {
            // Emit the new comment to all clients in the story room
            io.to(slug).emit("new-comment", {
              id: newComment.id,
              nome: newComment.nome,
              comentario: newComment.comentario,
              created_at: newComment.created_at,
            })
          }
          res.redirect(`/${slug}?success=Comentário adicionado com sucesso`)
        })
      },
    )
  })
})

// API endpoint to get comments for a story
app.get("/api/:slug/comentarios", (req, res) => {
  const slug = req.params.slug

  db.get("SELECT id FROM declaracoes WHERE slug = ?", [slug], (err, row) => {
    if (!row) return res.status(404).json({ error: "História não encontrada" })

    db.all(
      "SELECT * FROM comentarios WHERE declaracao_id = ? ORDER BY created_at DESC",
      [row.id],
      (err, comentarios) => {
        if (err) return res.status(500).json({ error: "Erro ao buscar comentários" })
        res.json(comentarios || [])
      },
    )
  })
})

// Gallery page to view all declarations
app.get("/galeria/todas", (req, res) => {
  db.all("SELECT * FROM declaracoes ORDER BY created_at DESC", (err, rows) => {
    if (err) {
      return res.status(500).send("Erro ao carregar a galeria")
    }

    res.render("galeria", {
      declaracoes: rows,
      pageTitle: "Galeria de Histórias de Amor",
    })
  })
})

// 404 page
app.use((req, res) => {
  res.status(404).render("404", { pageTitle: "Página não encontrada" })
})

// Update the server start message to show the BASE_URL if available
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando em ${baseUrl}`)
})
