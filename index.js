const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
require('dotenv').config();

const app = express();
app.use(express.json());

// Format token Telegram otomatis
const rawToken = process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_TOKEN = rawToken.trim().replace(/^bot/i, '');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Fungsi sanitasi URL YouTube
function cleanYouTubeUrl(rawUrl) {
  if (!rawUrl) return null;
  const str = String(rawUrl).trim();
  const match = str.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/))([a-zA-Z0-9_-]{11})/);
  if (match && match[1]) {
    return `https://www.youtube.com/watch?v=${match[1]}`;
  }
  return str.split('&')[0];
}

// Fungsi pengiriman pesan teks ke Telegram
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

// Fungsi pengiriman file video MP4 ke Telegram
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

// Fungsi download video dengan multi-metode (Cobalt API + yt-dlp cookies)
async function downloadSourceVideo(videoUrl, outputPath) {
  // Metode 1: Cobalt Stream API (Bypass blokir IP data center)
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

  // Metode 2: Fallback yt-dlp + Cookies
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
// ENDPOINT 1: AI Analisis 5 Klip Utuh Berdurasi Dinamis (1 - 5 Menit)
// ============================================================================
app.post('/analyze-video', async (req, res) => {
  const { url, chat_id } = req.body || {};
  const videoUrl = cleanYouTubeUrl(url);
  res.status(200).json({ status: 'Analysis started' });

  if (!videoUrl || !chat_id) return;

  try {
    await sendTelegramMsg(chat_id, '🧠 *AI sedang menyimak video dan mengkurasi 5 momen utuh (durasi 1–5 menit, tanpa terpotong)...*');

    const prompt = `Anda adalah Produser Konten Edukasi & Podcast Strategis untuk masyarakat Indonesia.
Tugas Anda: Dari video URL "${videoUrl}", temukan dan tentukan 5 REKOMENDASI KLIP TERBAIK (5 Topik Berbeda) yang kaya wawasan, edukatif, inovatif, atau bernilai inspirasi tinggi.

ATURAN STRUKTUR & DURASI KLIP:
1. JUMLAH KLIP: Tepat 5 klip dengan topik bahasan yang berbeda (tidak tumpang tindih).
2. DURASI DINAMIS (1 - 5 MENIT): Tentukan durasi antara 60 detik (1 menit) hingga 300 detik (5 menit).
3. BERHENTI SECARA ALAMI: Jangan memaksakan durasi. Jika poin pembahasan narasumber tuntas dalam 1 menit 30 detik atau 2 menit 45 detik, segera tentukan durasi selesai di detik tersebut.
4. ALUR UTUH (NARRATIVE ARC): Setiap klip harus mencakup pembukaan (konteks/masalah) -> penjelasan mendalam -> kesimpulan narasumber.
5. JANGAN MEMOTONG KALIMAT di tengah jalan.

Format output WAJIB HANYA berupa JSON valid:
{
  "clips": [
    {
      "clip_number": 1,
      "title": "Judul Klip",
      "start_time": "00:02:15",
      "duration": 110,
      "topic": "Mindset / Strategi / Cerita / Solusi / Nasihat",
      "summary": "Ringkasan pembahasan utuh.",
      "takeaway": "Poin utama yang didapat penonton."
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

    let msg = `💡 *5 Rekomendasi Klip Edukatif & Berbobot Utuh:*\n\n`;
    resultJson.clips.forEach((clip, idx) => {
      const menit = Math.floor(clip.duration / 60);
      const detik = clip.duration % 60;
      const durasiStr = menit > 0 ? `${menit}m ${detik}s` : `${detik}s`;

      msg += `*${idx + 1}. [${clip.topic}] ${clip.title}*\n`;
      msg += `⏱ Mulai: \`${clip.start_time}\` | Durasi: *${durasiStr}*\n`;
      msg += `📖 *Pembahasan:* _${clip.summary}_\n`;
      msg += `🎯 *Pesan Utama:* ${clip.takeaway}\n\n`;
    });

    await sendTelegramMsg(chat_id, msg);

  } catch (err) {
    console.error('Gagal analisis AI:', err.message);
    await sendTelegramMsg(chat_id, `❌ Gagal menganalisis video: ${err.message}`);
  }
});

// ============================================================================
// ENDPOINT 2: Render FFmpeg (9:16 Blurred Background, Suara Utuh & Fade-Out Elegan)
// ============================================================================
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
  const duration = parseInt(payload.timestamps?.duration_seconds || payload.duration || 60, 10);
  const chatId = payload.chat_id || payload.chatId || process.env.DEFAULT_TELEGRAM_CHAT_ID;
  const clipTitle = payload.title || payload.clip_title || 'Viral Clip';

  if (!videoUrl) return;

  const timestampId = Date.now();
  const rawDownload = path.join(__dirname, `raw_${timestampId}.mp4`);
  const outputClip = path.join(__dirname, `clip_${timestampId}.mp4`);

  try {
    const menit = Math.floor(duration / 60);
    const detik = duration % 60;
    const durasiText = menit > 0 ? `${menit}m ${detik}s` : `${detik}s`;

    await sendTelegramMsg(chatId, `⏳ *Sedang merender klip:*\n"${clipTitle}"\n⏱ Durasi: *${durasiText}*\n\nMohon tunggu sekitar 1-2 menit...`);

    // 1. Download video
    await downloadSourceVideo(videoUrl, rawDownload);

    // 2. Hitung transisi akhir (1.5 detik fade-out sebelum selesai)
    const fadeDuration = 1.5;
    const fadeStart = Math.max(0, duration - fadeDuration);

    // 3. Filter 9:16 Blurred Background + Video Fade-out
    const filterComplex = `[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:5[bg];[0:v]scale=720:-1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,fade=t=out:st=${fadeStart}:d=${fadeDuration}`;

    console.log('Mulai rendering FFmpeg (Video + Audio Utuh)...');
    await new Promise((resolve, reject) => {
      ffmpeg(rawDownload)
        .setStartTime(startTime)
        .setDuration(duration)
        .complexFilter(filterComplex)
        .audioFilters(`afade=t=out:st=${fadeStart}:d=${fadeDuration}`)
        .outputOptions([
          '-c:v libx264',
          '-preset ultrafast',
          '-c:a aac',
          '-b:a 192k',
          '-movflags +faststart'
        ])
        .output(outputClip)
        .on('end', () => {
          console.log('FFmpeg selesai!');
          resolve();
        })
        .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
        .run();
    });

    // 4. Kirim video hasil ke Telegram
    await sendTelegramVideo(
      chatId,
      outputClip,
      `🎬 *${clipTitle}*\n⏱ Durasi: *${durasiText}*\n\n✅ Suara asli jernih & transisi penutup elegan!`
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
