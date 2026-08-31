const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
require('dotenv').config();

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

function cleanYouTubeUrl(rawUrl) {
  if (!rawUrl) return null;
  const str = String(rawUrl).trim();
  const match = str.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/))([a-zA-Z0-9_-]{11})/);
  if (match && match[1]) {
    return `https://www.youtube.com/watch?v=${match[1]}`;
  }
  return str.split('&')[0];
}

async function sendTelegramMsg(chatId, text) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' })
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
    console.log('Video sukses terkirim ke Telegram!');
  } catch (e) {
    console.error('Gagal kirim video TG:', e.message);
    await sendTelegramMsg(chatId, `❌ Gagal kirim video ke Telegram: ${e.message}`);
  }
}

app.post('/render-webhook', async (req, res) => {
  const payload = req.body || {};
  res.status(200).json({ status: 'Processing started' });

  const rawUrl = payload.video_url || 
                 payload.source_url || 
                 payload.url || 
                 payload.clip_data?.source_url || 
                 payload.clip_data?.video_url;

  const videoUrl = cleanYouTubeUrl(rawUrl);
  const startTime = payload.timestamps?.start_time || payload.start_time || '00:00:10';
  const duration = payload.timestamps?.duration_seconds || payload.duration || 30;
  const chatId = payload.chat_id || payload.chatId || process.env.DEFAULT_TELEGRAM_CHAT_ID;
  const clipTitle = payload.title || payload.clip_title || 'Viral Clip';

  if (!videoUrl) {
    console.error('video_url tidak ditemukan');
    await sendTelegramMsg(chatId, '❌ Gagal: URL video tidak ditemukan.');
    return;
  }

  const rawDownload = path.join(__dirname, `raw_${Date.now()}.mp4`);
  const outputClip = path.join(__dirname, `clip_${Date.now()}.mp4`);
  const cookiePath = path.join(__dirname, 'cookies.txt');
  const cookieArg = fs.existsSync(cookiePath) ? `--cookies "${cookiePath}"` : '';

  try {
    console.log(`Mulai memproses: "${clipTitle}" | URL: ${videoUrl}`);
    await sendTelegramMsg(chatId, `⏳ *Sedang merender klip:*\n"${clipTitle}"\n\nMohon tunggu sekitar 1-2 menit...`);

    // Download video menggunakan yt-dlp + Deno JS Solver + Cookies resmi
    console.log('Mengunduh video via yt-dlp CLI...');
    await new Promise((resolve, reject) => {
      const cmd = `yt-dlp ${cookieArg} --no-check-certificates -f "b[ext=mp4]/bv*[ext=mp4]+ba[ext=m4a]/b/best" --merge-output-format mp4 -o "${rawDownload}" "${videoUrl}"`;
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(`yt-dlp: ${stderr || error.message}`));
        }
        resolve();
      });
    });

    console.log('Mulai rendering FFmpeg (9:16 vertical)...');
    await new Promise((resolve, reject) => {
      ffmpeg(rawDownload)
        .setStartTime(startTime)
        .setDuration(duration)
        .videoFilters([
          'crop=ih*(9/16):ih',
          'scale=720:1280'
        ])
        .outputOptions(['-c:v libx264', '-preset ultrafast', '-c:a aac'])
        .output(outputClip)
        .on('end', () => {
          console.log('FFmpeg selesai!');
          resolve();
        })
        .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
        .run();
    });

    await sendTelegramVideo(
      chatId, 
      outputClip, 
      `🎬 *${clipTitle}*\n⏱ Durasi: ${duration}s\n\nSiap diunggah ke TikTok / Reels / Shorts!`
    );

  } catch (err) {
    console.error('Proses gagal:', err.message);
    await sendTelegramMsg(chatId, `❌ Gagal memproses video: ${err.message}`);
  } finally {
    if (fs.existsSync(rawDownload)) {
      try { fs.unlinkSync(rawDownload); } catch(e){}
    }
    if (fs.existsSync(outputClip)) {
      try { fs.unlinkSync(outputClip); } catch(e){}
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker aktif pada port ${PORT}`));
