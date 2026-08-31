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

// Penyimpanan memori cache data 5 klip per chat
const clipsMemoryCache = new Map();

// Fungsi konversi waktu ke detik
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

// Fungsi pembersih URL YouTube
function cleanYouTubeUrl(rawUrl) {
  if (!rawUrl) return null;
  const str = String(rawUrl).trim();
  const match = str.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|shorts\/|live\/))([a-zA-Z0-9_-]{11})/);
  if (match && match[1]) {
    return `https://www.youtube.com/watch?v=${match[1]}`;
  }
  return str.split('&')[0];
}

// Fungsi kirim pesan teks ke Telegram
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

// Fungsi respon callback tombol Telegram
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

// Fungsi kirim file video MP4 ke Telegram
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

// Fungsi download video (Cobalt API + Fallback yt-dlp)
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
// CORE PIPELINE: RENDER VIDEO DENGAN CUPLIKAN PEMBUKA & TRANSISI OUTRO
// ============================================================================
async function executeRenderJob(params) {
  const { videoUrl, startTimeRaw, durationRaw, chatId, clipTitle, hookHeadline, socialCaption } = params;
  if (!videoUrl || !chatId) return;

  const startSec = parseTimeToSeconds(startTimeRaw);
  const durSec = Math.max(20, parseTimeToSeconds(durationRaw));

  const timestampId = Date.now();
  const rawDownload = path.join(__dirname, `raw_${timestampId}.mp4`);
  const outputClip = path.join(__dirname, `clip_${timestampId}.mp4`);

  try {
    const totalMenit = Math.floor(durSec / 60);
    const totalDetik = durSec % 60;
    const durasiText = totalMenit > 0 ? `${totalMenit}m ${totalDetik}s` : `${totalDetik}s`;

    await sendTelegramMsg(chatId, `⏳ *Sedang merender klip:*\n"${clipTitle}"\n⏱ Durasi: *${durasiText}* (Lengkap dengan Cuplikan Pembuka & Transisi)\n\nMohon tunggu sekitar 1-3 menit...`);

    // 1. Download video sumber
    await downloadSourceVideo(videoUrl, rawDownload);

    // 2. Hitung titik cuplikan intisari pembuka (3.5 detik dari bagian klimaks pesan)
    const teaserDur = durSec > 35 ? 3.5 : 2.5;
    const teaserStartSec = startSec + Math.max(5, Math.floor(durSec * 0.72));

    // 3. Hitung efek fade-out di penutup video utama (1.5 detik terakhir)
    const outroFadeDur = 1.5;
    const outroFadeStart = Math.max(0, durSec - outroFadeDur);

    // 4. Bangun Filter Complex FFmpeg: Cuplikan Teaser -> Transisi -> Klip Pembahasan Penuh
    const filterComplex = 
      `[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:5[bg0];` +
      `[0:v]scale=720:-1[fg0];` +
      `[bg0][fg0]overlay=(W-w)/2:(H-h)/2,fade=t=out:st=${teaserDur - 0.4}:d=0.4,fps=30,format=yuv420p[v0];` +
      `[0:a]afade=t=out:st=${teaserDur - 0.4}:d=0.4,aformat=sample_rates=44100:channel_layouts=stereo[a0];` +
      `[1:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:5[bg1];` +
      `[1:v]scale=720:-1[fg1];` +
      `[bg1][fg1]overlay=(W-w)/2:(H-h)/2,fade=t=in:st=0:d=0.4,fade=t=out:st=${outroFadeStart}:d=${outroFadeDur},fps=30,format=yuv420p[v1];` +
      `[1:a]afade=t=in:st=0:d=0.4,afade=t=out:st=${outroFadeStart}:d=${outroFadeDur},aformat=sample_rates=44100:channel_layouts=stereo[a1];` +
      `[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]`;

    console.log('Mulai rendering FFmpeg dengan Micro-Teaser + Full Clip...');
    const ffmpegCmd = `ffmpeg -y -ss ${teaserStartSec} -t ${teaserDur} -i "${rawDownload}" -ss ${startSec} -t ${durSec} -i "${rawDownload}" -filter_complex "${filterComplex}" -map "[outv]" -map "[outa]" -c:v libx264 -preset ultrafast -c:a aac -b:a 192k -movflags +faststart "${outputClip}"`;

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error, stdout, stderr) => {
        if (error || !fs.existsSync(outputClip)) {
          return reject(new Error(`FFmpeg error: ${stderr || error.message}`));
        }
        console.log('FFmpeg render berhasil!');
        resolve();
      });
    });

    // 5. Format caption pengiriman ke Telegram
    let captionText = `🎬 *${clipTitle}*\n⏱ Durasi: *${durasiText}*\n\n`;
    if (hookHeadline) captionText += `🎯 *Hook:* ${hookHeadline}\n\n`;
    if (socialCaption) captionText += `📝 *Caption Medsos:* \n${socialCaption}\n\n`;
    captionText += `⚡ _Lengkap dengan Cuplikan Pembuka (Detik 0–3s) & Transisi Halus!_`;

    await sendTelegramVideo(chatId, outputClip, captionText);

  } catch (err) {
    console.error('Proses gagal:', err.message);
    await sendTelegramMsg(chatId, `❌ Gagal memproses video: ${err.message}`);
  } finally {
    if (fs.existsSync(rawDownload)) try { fs.unlinkSync(rawDownload); } catch (e) {}
    if (fs.existsSync(outputClip)) try { fs.unlinkSync(outputClip); } catch (e) {}
  }
}

// ============================================================================
// AI KURATOR: ANALISIS & BUAT 5 KARTU PESAN DENGAN TOMBOL RENDER
// ============================================================================
async function handleAnalyzeAndSend5Clips(chatId, videoUrl) {
  try {
    await sendTelegramMsg(chatId, '🧠 *AI sedang menyimak video dan mengkurasi 5 klip edukatif berbobot (1–5 menit tanpa terpotong)...*\nMohon tunggu sekitar 15–30 detik.');

    const prompt = `Anda adalah Produser Konten Video Pendek & Ahli Viralitas Media Sosial Indonesia.
Tugas Anda: Dari video URL "${videoUrl}", temukan dan kurasi MINIMAL 5 REKOMENDASI KLIP TERBAIK (5 Topik Berbeda) yang kaya wawasan, edukatif, inovatif, atau bernilai inspirasi tinggi.

ATURAN WAJIB:
1. JUMLAH KLIP: Tepat 5 klip pilihan (Clip #1 sampai Clip #5) dengan topik bahasan berbeda (tidak saling tumpang tindih).
2. DURASI DINAMIS (1 - 5 MENIT): Tentukan durasi antara 60 detik (1 menit) hingga 300 detik (5 menit). Berhenti persis saat gagasan/pembahasan narasumber tuntas secara alami.
3. ALUR LENGKAP: Mengandung pembukaan konteks -> pembahasan mendalam -> kesimpulan tuntas dari narasumber. Jangan memotong kalimat di tengah jalan.
4. METADATA MEDSOS: Buat hook headline, tags, draft caption medsos, dan perkiraan reach.

Format output WAJIB HANYA JSON valid:
{
  "clips": [
    {
      "clip_number": 1,
      "title": "Judul Klip Menarik",
      "start_time": "00:01:20",
      "duration": 120,
      "virality_score": 88,
      "topic": "Mindset / Solusi / Kisah Nyata / Tips Bisnis",
      "hook_reason": "Menjelaskan prinsip penting yang sering diabaikan.",
      "tags": "#mindset #bisnis #edukasi",
      "social_tiktok": "Pola pikir penting yang jarang dibahas... #fyp #viral #bisnis",
      "social_shorts": "Wawasan penting hari ini #shorts #edukasi",
      "reach": "1K-10K"
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

    if (!resultJson.clips || !Array.isArray(resultJson.clips)) {
      throw new Error('Format respon AI tidak sesuai');
    }

    // Simpan daftar klip ke memori
    clipsMemoryCache.set(String(chatId), {
      videoUrl: videoUrl,
      clips: resultJson.clips
    });

    // Kirim 5 Kartu Klip ke Telegram
    for (const clip of resultJson.clips) {
      const startSec = parseTimeToSeconds(clip.start_time);
      const endSec = startSec + clip.duration;
      const startFormatted = formatSeconds(startSec);
      const endFormatted = formatSeconds(endSec);

      const m = Math.floor(clip.duration / 60);
      const s = clip.duration % 60;
      const durText = m > 0 ? `${m}m ${s}s` : `${s}s`;

      const cardMessage = 
`🎬 *Clip #${clip.clip_number}*
*${clip.title}*

⏱ \`${startFormatted} → ${endFormatted}\` (*${durText}*)
⚡ Virality: *${clip.virality_score || 85}/100*
📱 Format: *9:16 (Blurred BG)*

💡 _${clip.hook_reason}_

🏷 ${clip.tags || '#edukasi #viral'}

📱 *TikTok / Reels:*
${clip.social_tiktok || 'Simak pembahasannya! #fyp'}

▶️ *YouTube Shorts:*
${clip.social_shorts || 'Poin penting dari video ini #shorts'}

🎨 Visual: Teaser Hook (Detik 0-3s) + Outro Fade
📊 Reach: *${clip.reach || '1K-10K'}*`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: '🎥 Render Clip', callback_data: `render_${clip.clip_number}` },
            { text: '📱 Open in App', url: videoUrl }
          ]
        ]
      };

      await sendTelegramMsg(chatId, cardMessage, keyboard);
    }

  } catch (err) {
    console.error('Gagal analisis AI:', err.message);
    await sendTelegramMsg(chatId, `❌ Gagal menganalisis video: ${err.message}`);
  }
}

// ============================================================================
// TELEGRAM POLLING LISTENER (OTOMATIS TANGKAP CHAT & KLIK TOMBOL)
// ============================================================================
let lastUpdateId = 0;
async function startTelegramPolling() {
  if (!BOT_TOKEN) {
    console.log('TELEGRAM_BOT_TOKEN belum disetel, polling dilewati.');
    return;
  }
  console.log('Telegram Bot Polling aktif dan siap menerima pesan/link...');

  while (true) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=25`);
      const data = await res.json();

      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          lastUpdateId = update.update_id;

          // 1. Tangkap Pesan Masuk (Link YouTube)
          if (update.message && update.message.text) {
            const chatId = update.message.chat.id;
            const text = update.message.text.trim();

            if (text.startsWith('/start')) {
              await sendTelegramMsg(
                chatId,
                '👋 *Selamat datang di ClipMaster AI Bot!*\n\nKirimkan link video YouTube/Podcast ke sini. AI akan otomatis mengkurasi *5 klip terbaik berdurasi dinamis (1–5 menit)* yang utuh dan siap render.'
              );
              continue;
            }

            const youtubeUrl = cleanYouTubeUrl(text);
            if (youtubeUrl) {
              handleAnalyzeAndSend5Clips(chatId, youtubeUrl);
            } else if (!text.startsWith('/')) {
              await sendTelegramMsg(chatId, '⚠️ Silakan kirimkan link YouTube yang valid.');
            }
          }

          // 2. Tangkap Klik Tombol "Render Clip"
          if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message.chat.id;
            const dataStr = cb.data || '';

            if (dataStr.startsWith('render_')) {
              const clipNum = parseInt(dataStr.replace('render_', ''), 10);
              const cached = clipsMemoryCache.get(String(chatId));

              await answerCallback(cb.id, `✅ Memulai render Klip #${clipNum}...`);

              if (!cached || !cached.clips) {
                await sendTelegramMsg(chatId, '⚠️ Data klip sudah kedaluwarsa. Silakan kirim ulang link videonya.');
                continue;
              }

              const clip = cached.clips.find(c => c.clip_number === clipNum);
              if (!clip) {
                await sendTelegramMsg(chatId, '⚠️ Data klip tidak ditemukan.');
                continue;
              }

              await sendTelegramMsg(chatId, `✅ *Render job queued!*\n\nClip #${clipNum} has been added to the render queue. You'll be notified when the video is ready.`);

              // Eksekusi Render Video
              executeRenderJob({
                videoUrl: cached.videoUrl,
                startTimeRaw: clip.start_time,
                durationRaw: clip.duration,
                chatId: chatId,
                clipTitle: clip.title,
                hookHeadline: clip.hook_reason,
                socialCaption: clip.social_tiktok
              });
            }
          }
        }
      }
    } catch (err) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ============================================================================
// EXPRESS WEBHOOK ENDPOINTS (KOMPATIBILITAS EKSTERNAL)
// ============================================================================
app.post('/analyze-video', (req, res) => {
  const { url, chat_id } = req.body || {};
  const videoUrl = cleanYouTubeUrl(url);
  res.status(200).json({ status: 'Analysis started' });
  if (videoUrl && chat_id) handleAnalyzeAndSend5Clips(chat_id, videoUrl);
});

app.post('/render-webhook', (req, res) => {
  const payload = req.body || {};
  res.status(200).json({ status: 'Processing started' });

  const rawUrl = payload.video_url || payload.source_url || payload.url;
  const videoUrl = cleanYouTubeUrl(rawUrl);
  if (!videoUrl) return;

  executeRenderJob({
    videoUrl: videoUrl,
    startTimeRaw: payload.timestamps?.start_time || payload.start_time || '00:00:10',
    durationRaw: payload.timestamps?.duration_seconds || payload.duration || 60,
    chatId: payload.chat_id || payload.chatId || process.env.DEFAULT_TELEGRAM_CHAT_ID,
    clipTitle: payload.title || payload.clip_title || 'Viral Educational Clip',
    hookHeadline: payload.hook_headline || payload.hook || '',
    socialCaption: payload.social_caption || ''
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Worker aktif pada port ${PORT}`);
  startTelegramPolling(); // Mulai mendengarkan pesan Telegram secara otomatis
});
