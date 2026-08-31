const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
require('dotenv').config();

const app = express();
app.use(express.json());

const rawToken = process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_TOKEN = rawToken.trim().replace(/^bot/i, '');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

function cleanYouTubeUrl(rawUrl) {
  if (!rawUrl) return null;
  const str = String(rawUrl).trim();
  const match = str.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/))([a-zA-Z0-9_-]{11})/);
  if (match && match[1]) {
    return `https://www.youtube.com/watch?v=${match[1]}`;
  }
  return str.split('&')[0];
}

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
  } catch (e) {
    console.error('Gagal kirim video TG:', e.message);
    await sendTelegramMsg(chatId, `❌ Gagal kirim video ke Telegram: ${e.message}`);
  }
}

async function downloadSourceVideo(videoUrl, outputPath) {
  try {
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
      return;
    }
  } catch (e) {}

  const cookiePath = path.join(__dirname, 'cookies.txt');
  const cookieArg = fs.existsSync(cookiePath) ? `--cookies "${cookiePath}"` : '';

  await new Promise((resolve, reject) => {
    const cmd = `yt-dlp ${cookieArg} --no-check-certificates -f "b[ext=mp4]/best[ext=mp4]/best" -o "${outputPath}" "${videoUrl}"`;
    exec(cmd, (error, stdout, stderr) => {
      if (error && !fs.existsSync(outputPath)) return reject(new Error(`yt-dlp: ${stderr || error.message}`));
      resolve();
    });
  });
}

// Endpoint AI Kurator: Menganalisis video & memilih klip inspiratif
app.post('/analyze-video', async (req, res) => {
  const { url, chat_id } = req.body || {};
  const videoUrl = cleanYouTubeUrl(url);
  res.status(200).json({ status: 'Analysis started' });

  if (!videoUrl || !chat_id) return;

  try {
    await sendTelegramMsg(chat_id, '🧠 *AI sedang menyimak video dan mengkurasi momen paling bernilai & inspiratif...*');

    const prompt = `Anda adalah ahli kurasi konten video pendek Indonesia (TikTok/Reels/Shorts).
Tugas Anda: Dari video URL "${videoUrl}", tentukan 3 rekomendasi klip pendek (durasi 30-60 detik) yang paling kaya wawasan, edukatif, inspiratif, atau membuka pola pikir audiens Indonesia.

Format output WAJIB HANYA berupa JSON valid tanpa teks pengantar:
{
  "clips": [
    {
      "title": "Judul Klip Menarik",
      "start_time": "00:01:30",
      "duration": 45,
      "insight": "Poin penting yang dibahas di bagian ini."
    }
  ]
}`;

    const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
      })
    });

    const aiData = await aiRes.json();
    const resultJson = JSON.parse(aiData.candidates[0].content.parts[0].text);

    // Kirim rekomendasi klip ke Telegram
    let msg = `💡 *Rekomendasi Klip Bernilai Tinggi (AI Curated):*\n\n`;
    resultJson.clips.forEach((clip, idx) => {
      msg += `*${idx + 1}. ${clip.title}*\n⏱ Mulai: \`${clip.start_time}\` (${clip.duration}s)\n📌 Insight: _${clip.insight}_\n\n`;
    });

    await sendTelegramMsg(chat_id, msg);

  } catch (err) {
    console.error('Gagal analisis AI:', err.message);
    await sendTelegramMsg(chat_id, `❌ Gagal menganalisis video: ${err.message}`);
  }
});

// Endpoint Render FFmpeg
app.post('/render-webhook', async (req, res) => {
  const payload = req.body || {};
  res.status(200).json({ status: 'Processing started' });

  const rawUrl = payload.video_url || payload.source_url || payload.url;
  const videoUrl = cleanYouTubeUrl(rawUrl);
  const startTime = payload.timestamps?.start_time || payload.start_time || '00:00:10';
  const duration = payload.timestamps?.duration_seconds || payload.duration || 30;
  const chatId = payload.chat_id || payload.chatId || process.env.DEFAULT_TELEGRAM_CHAT_ID;
  const clipTitle = payload.title || payload.clip_title || 'Viral Clip';

  if (!videoUrl) return;

  const timestampId = Date.now();
  const rawDownload = path.join(__dirname, `raw_${timestampId}.mp4`);
  const outputClip = path.join(__dirname, `clip_${timestampId}.mp4`);

  try {
    await sendTelegramMsg(chatId, `⏳ *Sedang merender klip:*\n"${clipTitle}"\n\nMohon tunggu sekitar 1-2 menit...`);

    await downloadSourceVideo(videoUrl, rawDownload);

    // FFmpeg 9:16 Blurred Background
    const filterComplex = '[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:5[bg];[0:v]scale=720:-1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2';

    await new Promise((resolve, reject) => {
      ffmpeg(rawDownload)
        .setStartTime(startTime)
        .setDuration(duration)
        .complexFilter(filterComplex)
        .outputOptions(['-c:v libx264', '-preset ultrafast', '-c:a aac'])
        .output(outputClip)
        .on('end', resolve)
        .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
        .run();
    });

    await sendTelegramVideo(
      chatId,
      outputClip,
      `🎬 *${clipTitle}*\n⏱ Durasi: ${duration}s | 📱 Format: 9:16\n\nSiap diunggah ke TikTok / Reels / Shorts!`
    );

  } catch (err) {
    console.error('Proses gagal:', err.message);
    await sendTelegramMsg(chatId, `❌ Gagal memproses video: ${err.message}`);
  } finally {
    if (fs.existsSync(rawDownload)) try { fs.unlinkSync(rawDownload); } catch (e) {}
    if (fs.existsSync(outputClip)) try { fs.unlinkSync(outputClip); } catch (e) {}
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker aktif pada port ${PORT}`));
