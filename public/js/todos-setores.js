// ─── Estado de período ────────────────────────────────────────────────────────
const LABELS_PERIODO = {
  total:  '— Páginas totais',
  mes:    '— Últimos 30 dias',
  semana: '— Últimos 7 dias',
};

// Lê parâmetros iniciais da URL (vindo do dashboard)
const qs = new URLSearchParams(location.search);
let periodoAtual   = ['total', 'mes', 'semana'].includes(qs.get('periodo')) ? qs.get('periodo') : 'semana';
let intervaloAtivo = !!(qs.get('de') && qs.get('ate'));

let chartSetores  = null;
let impressorasLista = []; // dados {id, setor, modelo} das impressoras (sempre atualizados)

// ─── Inicializa controles de data ─────────────────────────────────────────────
if (qs.get('de'))  document.getElementById('filtro-de').value  = qs.get('de');
if (qs.get('ate')) document.getElementById('filtro-ate').value = qs.get('ate');

// ─── Atualiza label e botões de período ───────────────────────────────────────
function atualizarBotoesPeriodo(de, ate) {
  document.querySelectorAll('.periodo-btn').forEach(btn => {
    btn.classList.toggle('active', !intervaloAtivo && btn.dataset.periodo === periodoAtual);
  });
  const el = document.getElementById('label-periodo');
  if (!el) return;
  if (intervaloAtivo && de && ate) {
    const fmt = s => s.split('-').reverse().join('/');
    el.textContent = `— ${fmt(de)} a ${fmt(ate)}`;
  } else {
    el.textContent = LABELS_PERIODO[periodoAtual] ?? '';
  }
}

// ─── Renderiza o gráfico ──────────────────────────────────────────────────────
function renderChart(impressoras) {
  impressorasLista = impressoras;
  const labels = impressoras.map(r => {
    const setor = r.nome_setor ?? r.setor;
    const label = r.local_instalacao ? setor + ' — ' + r.local_instalacao : setor;
    return label.length > 45 ? label.slice(0, 45) + '…' : label;
  });
  const data   = {
    labels,
    datasets: [{
      label: 'Total de Páginas',
      data:  impressoras.map(r => r.total_paginas),
      backgroundColor: '#3b82f6',
      borderRadius: 4,
    }],
  };

  // Ajusta altura do canvas dinamicamente (min 320, ~36px por barra)
  const alturaMin = 320;
  const alturaCalc = Math.max(alturaMin, impressoras.length * 38);
  const wrapper = document.getElementById('chart-wrapper');
  wrapper.style.height = alturaCalc + 'px';
  const canvas = document.getElementById('chart-setores');
  canvas.style.height = alturaCalc + 'px';

  if (chartSetores) {
    Object.assign(chartSetores.data, data);
    chartSetores.update();
    return;
  }

  const ctx = canvas.getContext('2d');
  chartSetores = new Chart(ctx, {
    type: 'bar',
    data,
    options: {
      indexAxis: 'y',
      maintainAspectRatio: false,
      onClick: (_evt, elements) => {
        if (!elements.length) return;
        const imp = impressorasLista[elements[0].index];
        if (imp) location.href = `impressora.html?id=${imp.id}`;
      },
      plugins: {
        legend: { display: false },
        datalabels: {
          anchor: 'end',
          align: 'end',
          color: '#1e40af',
          font: { size: 12, weight: '700', family: 'system-ui, sans-serif' },
          backgroundColor: 'rgba(219,234,254,0.85)',
          borderRadius: 4,
          padding: { top: 2, bottom: 2, left: 5, right: 5 },
          formatter: v => v.toLocaleString('pt-BR'),
        },
      },
      scales: {
        x: { ticks: { font: { size: 12 } } },
        y: { ticks: { font: { size: 12 } } },
      },
      layout: { padding: { right: 80 } },
    },
  });

  canvas.style.cursor = 'pointer';
}

// ─── Renderiza tabela ─────────────────────────────────────────────────────────
function renderTabela(impressoras) {
  const tbody = document.getElementById('tbody-setores');
  if (!impressoras.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-5 text-muted">Nenhum dado encontrado para o período.</td></tr>';
    return;
  }
  tbody.innerHTML = impressoras.map((r, i) => {
    const resmas = Math.ceil((r.total_paginas ?? 0) / 500);
    return `
      <tr style="cursor:pointer" onclick="location.href='impressora.html?id=${r.id}'">
        <td class="text-muted fw-bold">${i + 1}</td>
        <td class="fw-medium">${r.modelo}</td>
        <td class="text-muted">${r.setor}</td>
        <td class="text-end font-monospace">${(r.total_paginas ?? 0).toLocaleString('pt-BR')}</td>
        <td class="text-end">
          <span class="badge bg-primary bg-opacity-10 text-primary border border-primary">
            ~${resmas} resma${resmas !== 1 ? 's' : ''}
          </span>
        </td>
      </tr>`;
  }).join('');
}

// ─── Carrega dados da API ─────────────────────────────────────────────────────
async function carregar() {
  let url = '/api/setores-paginas';
  if (intervaloAtivo) {
    const de  = document.getElementById('filtro-de').value;
    const ate = document.getElementById('filtro-ate').value;
    if (de && ate) url += `?de=${de}&ate=${ate}`;
  } else {
    url += `?periodo=${periodoAtual}`;
  }

  const resp = await fetch(url).then(r => r.json());
  const impressoras = resp.impressoras ?? [];

  const Badge = document.getElementById('badge-total-setores');
  if (Badge) Badge.textContent = `${impressoras.length} impressora${impressoras.length !== 1 ? 's' : ''}`;

  const sub = document.getElementById('subtitulo-chart');
  if (sub) sub.textContent = `${impressoras.length} impressora${impressoras.length !== 1 ? 's' : ''} encontrada${impressoras.length !== 1 ? 's' : ''}`;

  atualizarBotoesPeriodo(resp.de, resp.ate);
  renderChart(impressoras);
  renderTabela(impressoras);
}

// ─── Seletor de período ────────────────────────────────────────────────────────
document.querySelectorAll('.periodo-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!intervaloAtivo && btn.dataset.periodo === periodoAtual) return;
    periodoAtual   = btn.dataset.periodo;
    intervaloAtivo = false;
    if (chartSetores) { chartSetores.destroy(); chartSetores = null; }
    carregar();
  });
});

// ─── Filtro de intervalo livre ───────────────────────────────────────────────
document.getElementById('btn-aplicar-intervalo')?.addEventListener('click', () => {
  const de  = document.getElementById('filtro-de').value;
  const ate = document.getElementById('filtro-ate').value;
  if (!de || !ate) return;
  if (de > ate) { alert('A data de início deve ser anterior à data de fim.'); return; }
  intervaloAtivo = true;
  if (chartSetores) { chartSetores.destroy(); chartSetores = null; }
  carregar();
});

// ─── Marca botão inicial como active ──────────────────────────────────────────
document.querySelectorAll('.periodo-btn').forEach(btn => {
  btn.classList.toggle('active', !intervaloAtivo && btn.dataset.periodo === periodoAtual);
});

// ─── Carga inicial ────────────────────────────────────────────────────────────
carregar();
