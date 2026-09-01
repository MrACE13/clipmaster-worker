const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
require('dotenv').config();

const app = express();
app.use(express.json());

// Konfigurasi Token & API Key
const rawToken = process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_TOKEN = rawToken.trim().replace(/^bot/i, '');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Penyimpanan cache data 5 klip per chat
const clipsMemoryCache = new Map();

// Helper konversi waktu ke detik
function parseTimeToSeconds(timeInput) {
  if (typeof timeInput === 'number') return timeInput;
  if (!timeInput) return 0;
  const parts = String(timeInput).trim().split(':').map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parseFloat(timeInput) || 0;
}

function formatSeconds(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Pembersih URL YouTube
function cleanYouTubeUrl(rawUrl) {
  if (!rawUrl) return null;
  const str = String(rawUrl).trim();
  const match = str.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/))([a-zA-Z0-9_-]{11})/);
  if (match && match[1]) {
    return `https://www.youtube.com/watch?v=${match[1]}`;
  }
  return str.split('&')[0];
}

// Kirim pesan teks ke Telegram
async function sendTelegramMsg(chatId, text, replyMarkup = null) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    const payload = {
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('Gagal kirim pesan TG:', e.message);
  }
}

// Respon klik callback tombol
async function answerCallback(callbackQueryId, text = '') {
  if (!BOT_TOKEN || !callbackQueryId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text: text })
    });
  } catch (e) {}
}

// Kirim video MP4 ke Telegram
async function sendTelegramVideo(chatId, videoPath, caption) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    const fileBuffer = fs.readFileSync(videoPath);
    const blob = new Blob([fileBuffer], { type: 'video/mp4' });
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('video', blob, 'clip.mp4');
    formData.append('caption', caption);
    formData.append('supports_streaming', 'true');

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendVideo`, {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || 'Gagal upload video');
    console.log('Video sukses terkirim ke Telegram!');
  } catch (e) {
    console.error('Gagal kirim video TG:', e.message);
    await sendTelegramMsg(chatId, `❌ Gagal kirim video ke Telegram: ${e.message}`);
  }
}

// Download video sumber (Cobalt API + yt-dlp fallback)
async function downloadSourceVideo(videoUrl, outputPath) {
  try {
    console.log('Mencoba unduh via Cobalt Stream API...');
    const res = await fetch('https://api.cobalt.tools/', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      body: JSON.stringify({ url: videoUrl, videoQuality: '720', filenameStyle: 'basic' })
    });
    const data = await res.json();
    if (data && data.url) {
      const fileStream = await fetch(data.url);
      const buffer = await fileStream.arrayBuffer();
      fs.writeFileSync(outputPath, Buffer.from(buffer));
      console.log('Download via Cobalt berhasil!');
      return;
    }
  } catch (e) {
    console.log('Fallback ke yt-dlp internal...');
  }

  const cookiePath = path.join(__dirname, 'cookies.txt');
  const cookieArg = fs.existsSync(cookiePath) ? `--cookies "${cookiePath}"` : '';

  await new Promise((resolve, reject) => {
    const cmd = `yt-dlp ${cookieArg} --no-check-certificates -f "b[ext=mp4]/bv*[ext=mp4]+ba[ext=m4a]/b/best" --merge-output-format mp4 -o "${outputPath}" "${videoUrl}"`;
    exec(cmd, (error, stdout, stderr) => {
      if (error && !fs.existsSync(outputPath)) {
        return reject(new Error(`yt-dlp error: ${stderr || error.message}`));
      }
      resolve();
    });
  });
}

// ============================================================================
// TINGKAT 2: AI GENERATOR SUBTITLE KARAOKE BERGERAK (ASS FORMAT)
// ============================================================================
async function generateKaraokeSubtitles(rawVideoPath, startSec, durSec, outputAssPath) {
  if (!GEMINI_API_KEY) return false;
  const tempAudioPath = path.join(__dirname, `temp_audio_${Date.now()}.mp3`);

  try {
    console.log('Mengekstrak audio klip untuk AI Subtitle...');
    await new Promise((resolve, reject) => {
      exec(`ffmpeg -y -ss ${startSec} -t ${durSec} -i "${rawVideoPath}" -vn -acodec libmp3lame -b:a 128k -ar 44100 "${tempAudioPath}"`, (err) => {
        if (err || !fs.existsSync(tempAudioPath)) return reject(err);
        resolve();
      });
    });

    console.log('Mengirim audio ke Gemini untuk pembuatan Subtitle Karaoke...');
    const audioData = fs.readFileSync(tempAudioPath).toString('base64');

    const prompt = `Dengarkan audio podcast bahasa Indonesia ini. Buat transkripsi subtitle format ASS (Advanced Substation Alpha) bergaya video pendek viral (TikTok/Reels).

ATURAN SUBTITLE:
1. Bagi per baris menjadi frasa pendek (2 - 4 kata per baris) agar mudah dibaca cepat.
2. Berikan highlight kata aktif menggunakan tag warna kuning: {\\c&H0000FFFF&}KATA AKTIF{\\c&H00FFFFFF&}.
3. Tepatkan waktu start dan end persis sesuai audio (waktu relatif dari 0:00:00.00 hingga akhir klip).
4. Pastikan teks menggunakan bahasa Indonesia yang rapi.

Format output WAJIB HANYA berupa struktur ASS utuh seperti contoh berikut:
[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,24,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3.5,0,2,20,20,200

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.80,Default,,0,0,0,,{\\c&H0000FFFF&}JANGAN PERNAH{\\c&H00FFFFFF&} lakukan ini`;

    const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: "audio/mp3", data: audioData } },
            { text: prompt }
          ]
        }]
      })
    });

    const aiData = await aiRes.json();
    let assText = aiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    assText = assText.replace(/^```[a-zA-Z]*\n/, '').replace(/\n
