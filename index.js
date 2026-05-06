import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("session");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("SCAN QR INI DI WHATSAPP");
      console.log(qr);
    }

    if (connection === "close") {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !==
        DisconnectReason.loggedOut;

      console.log("Koneksi putus");

      if (shouldReconnect) {
        startBot();
      }
    }

    if (connection === "open") {
      console.log("BOT WHATSAPP TERHUBUNG");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];

    if (!msg.message) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text;

    if (!text) return;

    console.log("Pesan masuk:", text);

    if (text.toLowerCase().includes("halo")) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: "Halo juga kak 👋",
      });
    }
  });
}

startBot();
