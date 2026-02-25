// ─── Mapeamento modelo → imagem ───────────────────────────────────────────────
const MODELO_IMG = {
  'Samsung M4020': 'img/impressoras/m4020.jpg',
  'HP E52645':     'img/impressoras/e52645.jpg',
  'HP 408dn':      'img/impressoras/408dn.jpg',
  'HP E57540 Cor': 'img/impressoras/e57540.jpg',
  'HP E87660 A3':  'img/impressoras/e87660.jpg',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function corToner(nome) {
  const n = nome.toLowerCase();
  if (n.includes('preto') || n.includes('cartucho')) return '#2c2c2c';
  if (n.includes('ciano'))   return '#0891b2';
  if (n.includes('magenta')) return '#be185d';
  if (n.includes('amarelo')) return '#ca8a04';
  return '#6c757d';
}

function classePercentual(pct) {
  if (pct == null) return 'secondary';
  if (pct < 10)   return 'danger';
  if (pct < 20)   return 'warning';
  return 'success';
}

function timeAgo(isoStr) {
  if (!isoStr) return '—';
  const diff = Date.now() - new Date(isoStr).getTime();
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d atrás`;
  if (h > 0) return `${h}h atrás`;
  if (m > 0) return `${m}min atrás`;
  return 'agora';
}

function ehTonerPuro(nome) {
  const n = nome.toLowerCase();
  if (n.includes('unidade') || n.includes('coleta')) return false;
  return n.includes('toner') || n.includes('cartucho');
}

function ordemToner(nome) {
  const n = nome.toLowerCase();
  if (n.includes('preto') || n.includes('black') || n.includes('cartucho')) return 0;
  if (n.includes('ciano')   || n.includes('cyan'))    return 1;
  if (n.includes('magenta'))                           return 2;
  if (n.includes('amarelo') || n.includes('yellow'))  return 3;
  return 4;
}

function renderTonerBadges(consumiveis) {
  const toners = consumiveis
    .filter(c => ehTonerPuro(c.nome))
    .sort((a, b) => ordemToner(a.nome) - ordemToner(b.nome));
  if (!toners.length) return '<span class="text-muted">—</span>';

  return toners.map(t => {
    const cor = corToner(t.nome);
    const pct = t.percentual ?? '?';
    const cls = classePercentual(t.percentual);
    return `<span class="toner-badge border border-${cls}" style="background:${cor}" title="${t.nome}: ${pct}%">${pct}%</span>`;
  }).join(' ');
}

function renderTempoEstimado(consumiveis, diasRestantes) {
  // Mostra o preto/cartucho; fallback para o toner com menor tempo
  const toners = consumiveis
    .filter(c => ehTonerPuro(c.nome))
    .sort((a, b) => ordemToner(a.nome) - ordemToner(b.nome));
  if (!toners.length) return '<span class="text-muted">—</span>';

  // Coleta previsões disponíveis (só preto para mono; todos os cores)
  const previsoes = toners
    .map(t => ({ nome: t.nome, pct: t.percentual, dias: diasRestantes[t.nome] ?? null, ordem: ordemToner(t.nome) }))
    .filter(t => t.dias != null);

  if (!previsoes.length) return '<span class="text-muted">—</span>';

  // Prioriza o preto; se não tiver, usa o menor
  const alvo = previsoes.find(t => t.ordem === 0)
             ?? previsoes.reduce((a, b) => a.dias < b.dias ? a : b);

  const cls  = classePercentual(alvo.pct);
  let   icon, label;
  if (alvo.dias <= 7)  { icon = 'bi-alarm-fill';     label = 'text-danger'; }
  else if (alvo.dias <= 30) { icon = 'bi-clock-history'; label = 'text-warning'; }
  else                { icon = 'bi-clock';            label = 'text-success'; }

  return `
    <div class="d-flex align-items-center gap-2">
      <i class="bi ${icon} ${label}" style="font-size:1.1rem"></i>
      <div>
        <div class="fw-semibold text-${cls}">~${alvo.dias}d</div>
        <div class="text-muted" style="font-size:.78rem">${alvo.nome.split(' ').slice(-1)[0]}</div>
      </div>
    </div>`;
}

// ─── Estado de ordenação (persistido por sessão) ─────────────────────────────────
let dadosImpressoras = [];
let sortCol = sessionStorage.getItem('sortCol') ?? null;
let sortDir = parseInt(sessionStorage.getItem('sortDir') ?? '1');

function tonerPreto(consumiveis) {
  // Busca o toner preto explicitamente; fallback para o menor toner disponível
  const toners = consumiveis.filter(c => ehTonerPuro(c.nome));
  if (!toners.length) return 999;
  const preto = toners.find(c => {
    const n = c.nome.toLowerCase();
    return n.includes('preto') || n.includes('black') || n.includes('cartucho');
  });
  if (preto) return preto.percentual ?? 999;
  return Math.min(...toners.map(t => t.percentual ?? 999));
}

function tempoEstimadoDias(consumiveis, diasRestantes) {
  const toners = consumiveis.filter(c => ehTonerPuro(c.nome));
  const preto  = toners.find(t => ordemToner(t.nome) === 0);
  if (preto && diasRestantes[preto.nome] != null) return diasRestantes[preto.nome];
  const vals = toners.map(t => diasRestantes[t.nome]).filter(v => v != null);
  return vals.length ? Math.min(...vals) : 9999;
}

function sortarImpressoras(lista) {
  if (!sortCol) return lista;
  return [...lista].sort((a, b) => {
    switch (sortCol) {
      case 'modelo':  return sortDir * (a.modelo ?? '').localeCompare(b.modelo ?? '', 'pt-BR');
      case 'setor':   return sortDir * (a.setor  ?? '').localeCompare(b.setor  ?? '', 'pt-BR');
      case 'toner':   return sortDir * (tonerPreto(a.consumiveis) - tonerPreto(b.consumiveis));
      case 'tempo':   return sortDir * (tempoEstimadoDias(a.consumiveis, a.dias_restantes ?? {}) - tempoEstimadoDias(b.consumiveis, b.dias_restantes ?? {}));
      case 'paginas': return sortDir * ((a.total_paginas_dispositivo ?? -1) - (b.total_paginas_dispositivo ?? -1));
      case 'quando':  return sortDir * ((a.coletado_em ?? '').localeCompare(b.coletado_em ?? ''));
      case 'status':  return sortDir * ((a.coletado_em ? 0 : 1) - (b.coletado_em ? 0 : 1));
      default: return 0;
    }
  });
}

function atualizarHeadersSort() {
  document.querySelectorAll('.th-sort').forEach(th => {
    th.classList.remove('th-ativo');
    const icon = th.querySelector('i');
    if (icon) icon.className = 'bi bi-arrow-down-up';
    if (th.dataset.col === sortCol) {
      th.classList.add('th-ativo');
      if (icon) icon.className = sortDir === 1 ? 'bi bi-arrow-up' : 'bi bi-arrow-down';
    }
  });
}

function aplicarFiltroESort() {
  const q = document.getElementById('filtro').value.toLowerCase();
  let lista = dadosImpressoras;
  if (q) lista = lista.filter(imp =>
    (imp.modelo + ' ' + imp.setor).toLowerCase().includes(q)
  );
  renderTabela(sortarImpressoras(lista));
  atualizarHeadersSort();
}

// ─── Instâncias de Chart ──────────────────────────────────────────────────────
let chartDonut   = null;
let chartPaginas = null;

function renderCards(s) {
  document.getElementById('card-total').textContent    = s.total;
  document.getElementById('card-online').textContent   = s.online_hoje;
  document.getElementById('card-atencao').textContent  = s.atencao;
  document.getElementById('card-criticos').textContent = s.criticos;
}

function renderDonut(s) {
  const ctx  = document.getElementById('chart-donut').getContext('2d');
  const data = {
    labels:   ['OK (≥20%)', 'Atenção (10–20%)', 'Crítico (<10%)'],
    datasets: [{ data: [s.ok, s.atencao, s.criticos],
      backgroundColor: ['#198754', '#f59e0b', '#dc3545'], borderWidth: 2 }],
  };
  if (chartDonut) { Object.assign(chartDonut.data, data); chartDonut.update(); return; }
  chartDonut = new Chart(ctx, {
    type: 'doughnut', data,
    options: { cutout: '65%', plugins: { legend: { position: 'bottom' } } },
  });
}

function renderBarPaginas(top) {
  const ctx    = document.getElementById('chart-paginas').getContext('2d');
  const labels = top.map(r => r.setor.length > 35 ? r.setor.slice(0, 35) + '…' : r.setor);
  const data   = {
    labels,
    datasets: [{ label: 'Total de Páginas', data: top.map(r => r.total_paginas),
      backgroundColor: '#3b82f6', borderRadius: 4 }],
  };
  if (chartPaginas) { Object.assign(chartPaginas.data, data); chartPaginas.update(); return; }
  chartPaginas = new Chart(ctx, {
    type: 'bar', data,
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { font: { size: 13 } } },
        y: { ticks: { font: { size: 13 } } },
      },
    },
  });
}

function renderTabela(impressoras) {
  const hoje  = new Date().toISOString().slice(0, 10);
  const tbody = document.getElementById('tbody-impressoras');

  tbody.innerHTML = impressoras.map(imp => {
    const online  = imp.coletado_em?.slice(0, 10) === hoje;
    const img     = MODELO_IMG[imp.modelo] ?? '';
    const paginas = imp.total_paginas_dispositivo?.toLocaleString('pt-BR') ?? '—';
    const badges  = renderTonerBadges(imp.consumiveis);
    const tempo   = renderTempoEstimado(imp.consumiveis, imp.dias_restantes ?? {});
    const quando  = timeAgo(imp.coletado_em);
    const statusBadge = online
      ? '<span class="badge bg-success bg-opacity-10 text-success border border-success"><i class="bi bi-circle-fill me-1" style="font-size:.5rem"></i>Online</span>'
      : '<span class="badge bg-secondary bg-opacity-10 text-secondary border">Sem dados</span>';

    return `
      <tr onclick="location.href='impressora.html?id=${imp.id}'">
        <td>
          <div class="d-flex align-items-center gap-2">
            <img src="${img}" alt="${imp.modelo}" width="40" height="40"
                 style="object-fit:contain;border-radius:4px"
                 onerror="this.style.visibility='hidden'">
            <span class="fw-medium">${imp.modelo}</span>
          </div>
        </td>
        <td class="text-muted">${imp.setor}</td>
        <td>${badges}</td>
        <td class="col-oculta-mobile">${tempo}</td>
        <td class="col-oculta-mobile">${paginas}</td>
        <td class="col-oculta-mobile text-ago">${quando}</td>
        <td>${statusBadge}</td>
      </tr>`;
  }).join('');
}

// ─── Carga e atualização ──────────────────────────────────────────────────────
async function carregarTudo() {
  const [summary, impressoras] = await Promise.all([
    fetch('/api/summary').then(r => r.json()),
    fetch('/api/impressoras').then(r => r.json()),
  ]);

  dadosImpressoras = impressoras;

  renderCards(summary);
  renderDonut(summary);
  renderBarPaginas(summary.top_paginas);
  aplicarFiltroESort();

  document.getElementById('ultima-atualizacao').textContent =
    'Atualizado: ' + new Date().toLocaleTimeString('pt-BR');
}

// ─── Filtro da tabela ─────────────────────────────────────────────────────────
document.getElementById('filtro').addEventListener('input', () => aplicarFiltroESort());

// ─── Ordenação por coluna ─────────────────────────────────────────────────────
document.querySelectorAll('.th-sort').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (sortCol === col) { sortDir *= -1; } else { sortCol = col; sortDir = 1; }
    sessionStorage.setItem('sortCol', sortCol);
    sessionStorage.setItem('sortDir', sortDir);
    aplicarFiltroESort();
  });
});

// ─── Botão de atualizar ──────────────────────────────────────────────────────
document.getElementById('btn-refresh')?.addEventListener('click', () => carregarTudo());

// ─── Carga inicial ────────────────────────────────────────────────────────────
carregarTudo();
