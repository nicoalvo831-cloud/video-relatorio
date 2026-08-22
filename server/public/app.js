const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB — mesmo limite do servidor

const fileInput = document.getElementById('fileInput');
const dropzone = document.getElementById('dropzone');
const dzLabel = document.getElementById('dzLabel');
const filebar = document.getElementById('filebar');
const fileName = document.getElementById('fileName');
const fileSize = document.getElementById('fileSize');
const sendBtn = document.getElementById('sendBtn');
const errMsg = document.getElementById('errMsg');

const uploadDeck = document.getElementById('uploadDeck');
const progressDeck = document.getElementById('progressDeck');
const reportDeck = document.getElementById('reportDeck');
const logLine = document.getElementById('logLine');
const barFill = document.getElementById('barFill');
const pct = document.getElementById('pct');

let selectedFile = null;

fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.querySelector('.dz-inner').classList.add('drag');
});
dropzone.addEventListener('dragleave', () => {
  dropzone.querySelector('.dz-inner').classList.remove('drag');
});
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.querySelector('.dz-inner').classList.remove('drag');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});

function handleFile(file) {
  if (!file) return;
  errMsg.hidden = true;

  if (file.size > MAX_BYTES) {
    errMsg.textContent = `Este vídeo tem ${formatBytes(file.size)} — acima do limite de 2GB.`;
    errMsg.hidden = false;
    selectedFile = null;
    sendBtn.disabled = true;
    filebar.hidden = true;
    return;
  }

  selectedFile = file;
  dzLabel.textContent = 'Vídeo selecionado';
  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  filebar.hidden = false;
  sendBtn.disabled = false;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

sendBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  uploadDeck.hidden = true;
  progressDeck.hidden = false;
  updateProgress(2, 'a enviar vídeo…');

  const formData = new FormData();
  formData.append('video', selectedFile);

  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const uploadPct = Math.round((e.loaded / e.total) * 15); // envio conta ate 15% da barra
        updateProgress(uploadPct, 'a enviar vídeo…');
      }
    };

    xhr.onload = () => {
      if (xhr.status !== 200) {
        showError(JSON.parse(xhr.responseText || '{}').error || 'Falha no envio.');
        return;
      }
      const { jobId } = JSON.parse(xhr.responseText);
      pollStatus(jobId);
    };

    xhr.onerror = () => showError('Falha de rede ao enviar o vídeo.');
    xhr.send(formData);
  } catch (err) {
    showError(err.message);
  }
});

async function pollStatus(jobId) {
  const messages = {
    uploading: 'a preparar…',
    uploading_assemblyai: 'a enviar para transcrição…',
    transcribing: 'a transcrever áudio…',
    generating_report: 'a gerar relatório…',
    done: 'concluído',
    error: 'erro'
  };

  const poll = async () => {
    try {
      const res = await fetch(`/api/status/${jobId}`);
      const job = await res.json();

      if (job.status === 'error') {
        showError(job.error || 'Erro durante o processamento.');
        return;
      }

      updateProgress(job.progress || 0, messages[job.status] || 'a processar…');

      if (job.status === 'done') {
        showReport(job.report);
        return;
      }

      setTimeout(poll, 4000);
    } catch (err) {
      showError('Falha ao consultar o estado do processamento.');
    }
  };

  poll();
}

function updateProgress(percent, label) {
  barFill.style.width = `${percent}%`;
  pct.textContent = `${percent}%`;
  logLine.textContent = label;
}

function showError(message) {
  progressDeck.hidden = true;
  uploadDeck.hidden = false;
  errMsg.textContent = message;
  errMsg.hidden = false;
}

function showReport(report) {
  progressDeck.hidden = true;
  reportDeck.hidden = false;

  document.getElementById('resumo').textContent = report.resumo || '—';

  const pontosList = document.getElementById('pontos');
  pontosList.innerHTML = '';
  (report.pontos_chave || []).forEach((p) => {
    const li = document.createElement('li');
    li.textContent = p;
    pontosList.appendChild(li);
  });
  if (!report.pontos_chave || !report.pontos_chave.length) {
    pontosList.innerHTML = '<li>Nenhum ponto-chave identificado.</li>';
  }

  const acoesList = document.getElementById('acoes');
  acoesList.innerHTML = '';
  (report.acoes_decisoes || []).forEach((a) => {
    const li = document.createElement('li');
    li.textContent = a;
    acoesList.appendChild(li);
  });
  if (!report.acoes_decisoes || !report.acoes_decisoes.length) {
    acoesList.innerHTML = '<li>Nenhuma ação ou decisão identificada.</li>';
  }
}

document.getElementById('resetBtn').addEventListener('click', () => {
  reportDeck.hidden = true;
  uploadDeck.hidden = false;
  selectedFile = null;
  fileInput.value = '';
  dzLabel.textContent = 'Toque para escolher um vídeo';
  filebar.hidden = true;
  sendBtn.disabled = true;
  updateProgress(0, '');
});
