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

async function downloadSourceVideo(videoUrl, outputBase, outputPath) {
  // Coba Cobalt API
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

  // Fallback yt-dlp + Download Subtitle otomatis
  const cookiePath = path.join(__dirname, 'cookies.txt');
  const cookieArg = fs.existsSync(cookiePath) ? `--cookies "${cookiePath}"` : '';

  await new Promise((resolve, reject) => {
    const cmd = `yt-dlp ${cookieArg} --no-check-certificates --write-auto-sub --sub-lang "id,en" --convert-subs srt -f "b[ext=mp4]/best[ext=mp4]/best" -o "${outputBase}.%(ext)s" "${videoUrl}"`;
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
  const aspectRatio = payload.aspect_ratio || '9:16_blur'; // Opsi: '9:16_blur', '9:16_crop', '1:1', '16:9'

  if (!videoUrl) return;

  const timestampId = Date.now();
  const outputBase = path.join(__dirname, `raw_${timestampId}`);
  const rawDownload = `${outputBase}.mp4`;
  const outputClip = path.join(__dirname, `clip_${timestampId}.mp4`);

  try {
    await sendTelegramMsg(chatId, `⏳ *Sedang merender klip:*\n"${clipTitle}"\nFormat: *${aspectRatio}*\n\nMohon tunggu sekitar 1-2 menit...`);

    await downloadSourceVideo(videoUrl, outputBase, rawDownload);

    // Cari file subtitle jika berhasil diunduh
    let subFile = null;
    const possibleSubs = [`${outputBase}.id.srt`, `${outputBase}.en.srt`, `${outputBase}.srt`];
    for (const p of possibleSubs) {
      if (fs.existsSync(p)) { subFile = p; break; }
    }

    // Tentukan Filter Rasio Layar
    let filterComplex = '';
    if (aspectRatio === '9:16_blur') {
      // Blurred Background + Video Asli di tengah
      filterComplex = '[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:5[bg];[0:v]scale=720:-1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2';
    } else if (aspectRatio === '1:1') {
      // Persegi Kotak (Square)
      filterComplex = 'crop=min(iw\\,ih):min(iw\\,ih),scale=720:720';
    } else if (aspectRatio === '16:9') {
      // Landscape Horizontal Asli
      filterComplex = 'scale=1280:720';
    } else {
      // 9:16 Crop Tengah Langsung
      filterComplex = 'crop=ih*(9/16):ih,scale=720:1280';
    }

    // Tambahkan filter Subtitle jika file .srt tersedia
    if (subFile) {
      const sanitizedSubPath = subFile.replace(/\\/g, '/').replace(/:/g, '\\:');
      const subStyle = "force_style='FontSize=16,PrimaryColour=&H0000FFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=2,Alignment=2,MarginV=35'";
      if (filterComplex.includes('[bg]')) {
        filterComplex += `[v];[v]subtitles='${sanitizedSubPath}':${subStyle}`;
      } else {
        filterComplex += `,subtitles='${sanitizedSubPath}':${subStyle}`;
      }
    }

    // Eksekusi FFmpeg
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
        .on('end', resolve)
        .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
        .run();
    });

    await sendTelegramVideo(
      chatId,
      outputClip,
      `🎬 *${clipTitle}*\n⏱ Durasi: ${duration}s | 📱 Rasio: ${aspectRatio}\n\nSiap diunggah ke TikTok / Reels / Shorts / Feed!`
    );

  } catch (err) {
    console.error('Proses gagal:', err.message);
    await sendTelegramMsg(chatId, `❌ Gagal memproses video: ${err.message}`);
  } finally {
    // Bersihkan file sementara
    const filesToDelete = [rawDownload, outputClip, `${outputBase}.id.srt`, `${outputBase}.en.srt`, `${outputBase}.srt`];
    filesToDelete.forEach(f => {
      if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch (e) {}
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Worker aktif pada port ${PORT}`));
