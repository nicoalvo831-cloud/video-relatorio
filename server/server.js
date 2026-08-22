require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB - limite exigido
const UPLOAD_DIR = path.join(__dirname, 'tmp_uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_BYTES } // limite tambem aplicado NO SERVIDOR (nao confiar so no frontend)
});

const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!ASSEMBLYAI_KEY || !ANTHROPIC_KEY) {
  console.warn('AVISO: configure ASSEMBLYAI_API_KEY e ANTHROPIC_API_KEY no .env antes de usar em producao.');
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// Job store simples em memoria (para producao real, trocar por Redis/DB)
const jobs = new Map();
// job: { status: 'uploading'|'transcribing'|'generating_report'|'done'|'error', progress, transcript, report, error }

function updateJob(id, patch) {
  const current = jobs.get(id) || {};
  jobs.set(id, { ...current, ...patch });
}

// 1. Recebe o video e comeca o processamento em background
app.post('/api/upload', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo de video enviado.' });
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(jobId, { status: 'uploading', progress: 5 });

  res.json({ jobId }); // responde IMEDIATAMENTE, processamento continua async

  processVideo(jobId, req.file.path).catch((err) => {
    console.error('Erro no processamento:', err);
    updateJob(jobId, { status: 'error', error: err.message || 'Erro desconhecido' });
  });
});

async function processVideo(jobId, filePath) {
  try {
    // --- Passo 1: enviar arquivo para AssemblyAI ---
    updateJob(jobId, { status: 'uploading_assemblyai', progress: 15 });

    const fileStream = fs.createReadStream(filePath);
    const uploadResp = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { authorization: ASSEMBLYAI_KEY },
      body: fileStream
    });

    if (!uploadResp.ok) {
      throw new Error(`Falha no upload para AssemblyAI: ${uploadResp.status}`);
    }
    const uploadJson = await uploadResp.json();
    const audioUrl = uploadJson.upload_url;

    // apaga arquivo local temporario assim que o upload termina, pra nao lotar disco
    fs.unlink(filePath, () => {});

    // --- Passo 2: pedir transcricao ---
    updateJob(jobId, { status: 'transcribing', progress: 30 });

    const transcriptResp = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        authorization: ASSEMBLYAI_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        audio_url: audioUrl,
        language_detection: true
      })
    });

    if (!transcriptResp.ok) {
      throw new Error(`Falha ao criar transcricao: ${transcriptResp.status}`);
    }
    const transcriptJson = await transcriptResp.json();
    const transcriptId = transcriptJson.id;

    // --- Passo 3: fazer polling ate a transcricao terminar ---
    let transcriptText = null;
    let attempts = 0;
    while (attempts < 240) { // ate ~20min de polling (5s cada)
      await sleep(5000);
      attempts++;

      const pollResp = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { authorization: ASSEMBLYAI_KEY }
      });
      const pollJson = await pollResp.json();

      if (pollJson.status === 'completed') {
        transcriptText = pollJson.text;
        break;
      } else if (pollJson.status === 'error') {
        throw new Error(`Transcricao falhou: ${pollJson.error}`);
      }
      // atualiza progresso estimado entre 30% e 70%
      const estProgress = Math.min(70, 30 + attempts);
      updateJob(jobId, { progress: estProgress });
    }

    if (!transcriptText) {
      throw new Error('Timeout esperando a transcricao terminar.');
    }

    updateJob(jobId, { status: 'generating_report', progress: 80, transcript: transcriptText });

    // --- Passo 4: gerar relatorio estruturado com a API da Anthropic ---
    const reportMsg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: `Aqui esta a transcricao de um video:\n\n"""${transcriptText}"""\n\nGere um relatorio em portugues APENAS em formato JSON valido (sem markdown, sem explicacao, sem crases), com esta estrutura exata:\n{\n  "resumo": "string com um resumo geral de 3-5 frases",\n  "pontos_chave": ["ponto 1", "ponto 2", "..."],\n  "acoes_decisoes": ["acao ou decisao 1", "acao ou decisao 2", "..."]\n}\nSe nao houver acoes ou decisoes claras no conteudo, retorne um array vazio em "acoes_decisoes".`
        }
      ]
    });

    const rawText = reportMsg.content.find((c) => c.type === 'text')?.text || '{}';
    let report;
    try {
      const cleaned = rawText.replace(/```json|```/g, '').trim();
      report = JSON.parse(cleaned);
    } catch (e) {
      report = { resumo: rawText, pontos_chave: [], acoes_decisoes: [] };
    }

    updateJob(jobId, { status: 'done', progress: 100, report });
  } catch (err) {
    updateJob(jobId, { status: 'error', error: err.message });
    throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 2. Frontend consulta o status do job
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job nao encontrado.' });
  res.json(job);
});

// erro de tamanho de arquivo do multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Arquivo excede o limite de 2GB.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Erro interno no servidor.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
