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

async function downloadSourceVideo(videoUrl, outputPath) {
  // Metode 1: Cobalt Stream API (Bypass Data Center IP block)
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

  // Metode 2: Fallback yt-dlp murni tanpa request subtitle yang memicu blokir 429
  const cookiePath = path.join(__dirname, 'cookies.txt');
  const cookieArg = fs.existsSync(cookiePath) ? `--cookies "${cookiePath}"` : '';

  await new Promise((resolve, reject) => {
    const cmd = `yt-dlp ${cookieArg} --no-check-certificates -f "b[ext=mp4]/best[ext=mp4]/best" -o "${outputPath}" "${videoUrl}"`;
    exec(cmd, (error, stdout, stderr) => {
      if (error && !fs.existsSync(outputPath)) {
        return reject(new Error(`yt-dlp error: ${stderr || error.message}`));
      }
      resolve();
    });
  });
}

app.post('/render-webhook', async (req, res) => {
  const payload = req.body || {};
  res.status(200).json({ status: 'Processing started' });

  const rawUrl = payload.video_url || payload.source_url || payload.url || payload.clip_data?.source_url || payload.clip_data?.video_url;
  const videoUrl = cleanYouTubeUrl(rawUrl);
  const startTime = payload.timestamps?.start_time || payload.start_time || '00:00:10';
  const duration = payload.timestamps?.duration_seconds || payload.duration || 30;
  const chatId = payload.chat_id || payload.chatId || process.env.DEFAULT_TELEGRAM_CHAT_ID;
  const clipTitle = payload.title || payload.clip_title || 'Viral Clip';
  const aspectRatio = payload.aspect_ratio || '9:16_blur'; 

  if (!videoUrl) return;

  const timestampId = Date.now();
  const rawDownload = path.join(__dirname, `raw_${timestampId}.mp4`);
  const outputClip = path.join(__dirname, `clip_${timestampId}.mp4`);

  try {
    await sendTelegramMsg(chatId, `⏳ *Sedang merender klip:*\n"${clipTitle}"\nFormat: *${aspectRatio}*\n\nMohon tunggu sekitar 1-2 menit...`);

    // Download video sumber
    await downloadSourceVideo(videoUrl, rawDownload);

    // Filter penyesuaian rasio layar
    let filterComplex = '';
    if (aspectRatio === '9:16_blur') {
      // Blurred Background: Video landscape tetap utuh di tengah dengan background blur
      filterComplex = '[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:5[bg];[0:v]scale=720:-1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2';
    } else if (aspectRatio === '1:1') {
      filterComplex = 'crop=min(iw\\,ih):min(iw\\,ih),scale=720:720';
    } else if (aspectRatio === '16:9') {
      filterComplex = 'scale=1280:720';
    } else {
      filterComplex = 'crop=ih*(9/16):ih,scale=720:1280';
    }

    console.log('Mulai rendering FFmpeg...');
    await new Promise((resolve, reject) => {
      let ffmpegCmd = ffmpeg(rawDownload)
        .setStartTime(startTime)
        .setDuration(duration);

      if (filterComplex.includes('[bg]')) {
        ffmpegCmd.complexFilter(filterComplex);
      } else {
        ffmpegCmd.videoFilters(filterComplex);
      }

      ffmpegCmd
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
      `🎬 *${clipTitle}*\n⏱ Durasi: ${duration}s | 📱 Rasio: ${aspectRatio}\n\nSiap diunggah ke TikTok / Reels / Shorts!`
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
