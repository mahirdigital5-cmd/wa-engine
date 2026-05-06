import express from "express";
import pino from "pino";
import qrcode from "qrcode";
import { createClient } from "@supabase/supabase-js";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

let sock;
let latestQR = null;
let isConnected = false;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["ChatBotNexis", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = await qrcode.toDataURL(qr);
      console.log("QR baru dibuat");
    }

    if (connection === "open") {
      isConnected = true;
      latestQR = null;
      console.log("WhatsApp connected");
    }

    if (connection === "close") {
      isConnected = false;

      const reason =
        lastDisconnect?.error?.output?.statusCode;

      console.log("WhatsApp disconnected:", reason);

      if (reason !== DisconnectReason.loggedOut) {
        startBot();
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];

    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    if (!text) return;

    console.log("Pesan masuk:", text);

    const { data: triggers, error } = await supabase
      .from("triggers")
      .select("*")
      .eq("active", true);

    if (error) {
      console.log("Supabase error:", error.message);
      return;
    }

    const messageText = text.toLowerCase();

    const matched = triggers.find((item) => {
      const keyword = item.keyword.toLowerCase();

      if (item.type === "Sama Persis") {
        return messageText === keyword;
      }

      return messageText.includes(keyword);
    });

    if (matched) {
      await sock.sendMessage(from, {
        text: matched.response,
      });

      console.log("Auto reply:", matched.response);
    }
  });
}

app.get("/", (req, res) => {
  res.json({
    status: "WA Engine aktif",
    connected: isConnected,
  });
});

app.get("/qr", (req, res) => {
  if (isConnected) {
    return res.send(`
      <h2>WhatsApp sudah terhubung ✅</h2>
    `);
  }

  if (!latestQR) {
    return res.send(`
      <h2>QR belum siap, refresh 5 detik lagi...</h2>
    `);
  }

  res.send(`
    <div style="font-family: Arial; text-align: center; margin-top: 40px;">
      <h2>Scan QR WhatsApp</h2>
      <img src="${latestQR}" style="width: 300px;" />
      <p>Buka WhatsApp → Perangkat tertaut → Tautkan perangkat</p>
    </div>
  `);
});

app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startBot();
});
